import * as assert from 'assert';
import { buildApplyDigest } from '../../src/results/apply-digest';
import { DigestMeta } from '../../src/results/plan-digest';
import { MAX_DIAGNOSTICS } from '../../src/results/caps';

const META: DigestMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-apply',
  createdIso: '2026-07-15T00:00:00Z',
};

function line(o: unknown): string {
  return JSON.stringify(o);
}

describe('buildApplyDigest', () => {
  it('parses a successful stream: resources, durations, outcome, summary, outputs', () => {
    const ndjson = [
      line({ '@timestamp': '2026-07-15T10:00:00.000Z', type: 'version', terraform: '1.9.5' }),
      line({ '@timestamp': '2026-07-15T10:00:01.000Z', type: 'apply_start', hook: { resource: { addr: 'aws_s3_bucket.data' }, action: 'create' } }),
      line({ '@timestamp': '2026-07-15T10:00:03.000Z', type: 'apply_complete', hook: { resource: { addr: 'aws_s3_bucket.data' }, action: 'create', elapsed_seconds: 2 } }),
      line({ '@timestamp': '2026-07-15T10:00:03.500Z', type: 'change_summary', changes: { add: 1, change: 0, remove: 0, operation: 'apply' } }),
      line({ '@timestamp': '2026-07-15T10:00:03.600Z', type: 'outputs', outputs: { bucket_name: { sensitive: false, type: 'string', value: 'my-bucket' } } }),
    ].join('\n');
    const d = buildApplyDigest(ndjson, META);
    assert.strictEqual(d.outcome, 'succeeded');
    assert.strictEqual(d.tool.version, '1.9.5');
    assert.strictEqual(d.resources.length, 1);
    assert.deepStrictEqual(d.resources[0], { address: 'aws_s3_bucket.data', action: 'create', status: 'complete', durationMs: 2000 });
    assert.deepStrictEqual(d.summary, { add: 1, change: 0, destroy: 0, durationMs: 3600 });
    assert.deepStrictEqual(d.outputs, [{ name: 'bucket_name', action: 'no-op', value: { kind: 'value', json: '"my-bucket"' } }]);
    assert.strictEqual(d.appliedBeforeFailure, undefined);
    assert.strictEqual(d.truncated, false);
  });

  it('computes durationMs from start/complete timestamps (not Date.now)', () => {
    const ndjson = [
      line({ '@timestamp': '2026-07-15T10:00:00.000Z', type: 'apply_start', hook: { resource: { addr: 'r.a' }, action: 'update' } }),
      line({ '@timestamp': '2026-07-15T10:00:07.500Z', type: 'apply_complete', hook: { resource: { addr: 'r.a' }, action: 'update' } }),
    ].join('\n');
    const d = buildApplyDigest(ndjson, META);
    assert.strictEqual(d.resources[0].durationMs, 7500);
  });

  it('marks a partial failure: outcome failed, appliedBeforeFailure lists completed addresses, errored status set', () => {
    const ndjson = [
      line({ '@timestamp': '2026-07-15T11:00:01.000Z', type: 'apply_start', hook: { resource: { addr: 'r.ok' }, action: 'create' } }),
      line({ '@timestamp': '2026-07-15T11:00:02.000Z', type: 'apply_complete', hook: { resource: { addr: 'r.ok' }, action: 'create' } }),
      line({ '@timestamp': '2026-07-15T11:00:02.100Z', type: 'apply_start', hook: { resource: { addr: 'r.bad' }, action: 'create' } }),
      line({ '@timestamp': '2026-07-15T11:00:04.000Z', type: 'apply_errored', hook: { resource: { addr: 'r.bad' }, action: 'create' } }),
    ].join('\n');
    const d = buildApplyDigest(ndjson, META);
    assert.strictEqual(d.outcome, 'failed');
    assert.deepStrictEqual(d.appliedBeforeFailure, ['r.ok']);
    const bad = d.resources.find((r) => r.address === 'r.bad');
    const ok = d.resources.find((r) => r.address === 'r.ok');
    assert.strictEqual(bad?.status, 'errored');
    assert.strictEqual(ok?.status, 'complete');
  });

  it('treats an error-severity diagnostic as a failed apply', () => {
    const ndjson = line({ '@timestamp': '2026-07-15T11:00:04.100Z', type: 'diagnostic', diagnostic: { severity: 'error', summary: 'boom' } });
    assert.strictEqual(buildApplyDigest(ndjson, META).outcome, 'failed');
  });

  it('tolerates malformed / partial NDJSON lines (skipped + noted, never throws)', () => {
    const ndjson = [
      line({ '@timestamp': '2026-07-15T11:00:01.000Z', type: 'apply_start', hook: { resource: { addr: 'r.ok' }, action: 'create' } }),
      'this is not json {{{',
      '',
      '{ "partial": ',
      line({ '@timestamp': '2026-07-15T11:00:02.000Z', type: 'apply_complete', hook: { resource: { addr: 'r.ok' }, action: 'create' } }),
    ].join('\n');
    let d: ReturnType<typeof buildApplyDigest>;
    assert.doesNotThrow(() => {
      d = buildApplyDigest(ndjson, META);
    });
    d = buildApplyDigest(ndjson, META);
    assert.strictEqual(d.resources.length, 1);
    assert.strictEqual(d.truncated, true);
    assert.ok((d.truncationNotes ?? []).some((n) => n.includes('malformed apply event line')));
  });

  it('masks sensitive outputs from the outputs event', () => {
    const ndjson = line({ '@timestamp': '2026-07-15T10:00:03.600Z', type: 'outputs', outputs: { pw: { sensitive: true, type: 'string', value: 'APPLY_TOPSECRET' }, host: { sensitive: false, type: 'string', value: 'h' } } });
    const d = buildApplyDigest(ndjson, META);
    const pw = d.outputs.find((o) => o.name === 'pw');
    assert.deepStrictEqual(pw?.value, { kind: 'sensitive' });
    assert.ok(!JSON.stringify(d).includes('APPLY_TOPSECRET'));
  });

  describe('diagnostics', () => {
    const diagLine = line({ type: 'diagnostic', diagnostic: { severity: 'error', summary: 'bad password: SEKRET_pw_value', detail: 'the password SEKRET_pw_value failed', address: 'r.bad' } });

    it('omits detail by default (safe mode) and scrubs the known secret from summary', () => {
      const d = buildApplyDigest(diagLine, META, { knownSecrets: ['SEKRET_pw_value'] });
      assert.strictEqual(d.diagnostics.length, 1);
      assert.strictEqual(d.diagnostics[0].detail, undefined);
      assert.ok(!d.diagnostics[0].summary.includes('SEKRET_pw_value'));
      assert.strictEqual(d.diagnostics[0].address, 'r.bad');
      assert.ok(!JSON.stringify(d).includes('SEKRET_pw_value'));
    });

    it('includes scrubbed detail when includeDiagnosticDetail is set', () => {
      const d = buildApplyDigest(diagLine, META, { knownSecrets: ['SEKRET_pw_value'], includeDiagnosticDetail: true });
      assert.ok(d.diagnostics[0].detail !== undefined);
      assert.ok(!d.diagnostics[0].detail!.includes('SEKRET_pw_value'));
    });

    it('caps diagnostics keeping errors first, and notes the remainder', () => {
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) lines.push(line({ type: 'diagnostic', diagnostic: { severity: 'warning', summary: `w${i}` } }));
      for (let i = 0; i < MAX_DIAGNOSTICS; i++) lines.push(line({ type: 'diagnostic', diagnostic: { severity: 'error', summary: `e${i}` } }));
      const d = buildApplyDigest(lines.join('\n'), META);
      assert.strictEqual(d.diagnostics.length, MAX_DIAGNOSTICS);
      assert.ok(d.diagnostics.every((x) => x.severity === 'error'), 'errors survive, warnings dropped past the cap');
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('diagnostics capped')));
    });
  });

  it('derives summary counts from resources when no change_summary event is present', () => {
    const ndjson = [
      line({ type: 'apply_complete', hook: { resource: { addr: 'r.c' }, action: 'create' } }),
      line({ type: 'apply_complete', hook: { resource: { addr: 'r.u' }, action: 'update' } }),
      line({ type: 'apply_complete', hook: { resource: { addr: 'r.d' }, action: 'delete' } }),
    ].join('\n');
    const d = buildApplyDigest(ndjson, META);
    assert.strictEqual(d.summary.add, 1);
    assert.strictEqual(d.summary.change, 1);
    assert.strictEqual(d.summary.destroy, 1);
  });

  it('does not throw on empty input', () => {
    assert.doesNotThrow(() => buildApplyDigest('', META));
    const d = buildApplyDigest('', META);
    assert.strictEqual(d.outcome, 'succeeded');
    assert.strictEqual(d.resources.length, 0);
  });
});
