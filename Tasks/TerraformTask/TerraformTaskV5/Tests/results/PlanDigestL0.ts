import * as assert from 'assert';
import { buildPlanDigest, DigestMeta, capNotes } from '../../src/results/plan-digest';
import { MAX_RESOURCES, MAX_ATTR_CHANGES_PER_RESOURCE, MAX_OUTPUTS, MAX_DRIFT, MAX_NOTES } from '../../src/results/caps';

const META: DigestMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-plan',
  workingDirectory: 'infra',
  createdIso: '2026-07-15T00:00:00Z',
};

function change(overrides: Record<string, unknown>) {
  return { actions: ['no-op'], before: {}, after: {}, after_unknown: {}, before_sensitive: {}, after_sensitive: {}, ...overrides };
}

describe('buildPlanDigest', () => {
  it('classifies create/update/delete/read/no-op and counts the summary', () => {
    const plan = {
      terraform_version: '1.9.5',
      resource_changes: [
        { address: 'r.c', type: 't', name: 'c', provider_name: 'p', change: change({ actions: ['create'], before: null, after: { x: 1 } }) },
        { address: 'r.u', type: 't', name: 'u', provider_name: 'p', change: change({ actions: ['update'], before: { x: 1 }, after: { x: 2 } }) },
        { address: 'r.d', type: 't', name: 'd', provider_name: 'p', change: change({ actions: ['delete'], before: { x: 1 }, after: null }) },
        { address: 'r.r', type: 't', name: 'r', provider_name: 'p', change: change({ actions: ['read'], before: null, after: { x: 1 } }) },
        { address: 'r.n', type: 't', name: 'n', provider_name: 'p', change: change({ actions: ['no-op'], before: { x: 1 }, after: { x: 1 } }) },
      ],
      output_changes: {},
    };
    const d = buildPlanDigest(plan, META);
    assert.deepStrictEqual(d.summary, { add: 1, change: 1, destroy: 1, replace: 0, read: 1, noChanges: false, driftDetected: false });
    assert.strictEqual(d.resources.length, 5);
  });

  it('treats a two-element [delete,create] as a replace in the summary (add+destroy+replace)', () => {
    const plan = {
      terraform_version: '1.9.5',
      resource_changes: [
        { address: 'r.x', type: 't', name: 'x', provider_name: 'p', action_reason: 'replace_because_cannot_update', change: change({ actions: ['delete', 'create'], before: { a: 1 }, after: { a: 2 }, replace_paths: [['a']] }) },
      ],
      output_changes: {},
    };
    const d = buildPlanDigest(plan, META);
    assert.deepStrictEqual(d.summary, { add: 1, change: 0, destroy: 1, replace: 1, read: 0, noChanges: false, driftDetected: false });
    assert.strictEqual(d.resources[0].actionReason, 'replace_because_cannot_update');
    assert.deepStrictEqual(d.resources[0].replacePaths, ['a']);
  });

  it('emits ONLY changed attributes, skipping unchanged ones', () => {
    const plan = {
      terraform_version: '1.9.5',
      resource_changes: [
        { address: 'r.u', type: 't', name: 'u', provider_name: 'p', change: change({ actions: ['update'], before: { same: 1, diff: 'old' }, after: { same: 1, diff: 'new' } }) },
      ],
      output_changes: {},
    };
    const d = buildPlanDigest(plan, META);
    const attrs = d.resources[0].attributeChanges;
    assert.strictEqual(attrs.length, 1);
    assert.strictEqual(attrs[0].path, 'diff');
    assert.deepStrictEqual(attrs[0].before, { kind: 'value', json: '"old"' });
    assert.deepStrictEqual(attrs[0].after, { kind: 'value', json: '"new"' });
  });

  it('surfaces an unknown after value without ever emitting the before as the after (§2.7)', () => {
    const plan = {
      terraform_version: '1.9.5',
      resource_changes: [
        { address: 'r.u', type: 't', name: 'u', provider_name: 'p', change: change({ actions: ['update'], before: { ip: '10.0.0.1' }, after: { ip: null }, after_unknown: { ip: true } }) },
      ],
      output_changes: {},
    };
    const d = buildPlanDigest(plan, META);
    const attr = d.resources[0].attributeChanges[0];
    assert.strictEqual(attr.path, 'ip');
    assert.deepStrictEqual(attr.after, { kind: 'unknown' });
    // the old value is the "before"; it must never surface as the after.
    assert.deepStrictEqual(attr.before, { kind: 'value', json: '"10.0.0.1"' });
    assert.ok(!JSON.stringify(attr.after).includes('10.0.0.1'));
  });

  it('sets driftDetected and builds masked drift resources from resource_drift', () => {
    const plan = {
      terraform_version: '1.9.5',
      resource_changes: [],
      resource_drift: [
        { address: 'r.w', type: 't', name: 'w', provider_name: 'p', change: change({ actions: ['update'], before: { tag: 'old' }, after: { tag: 'real' } }) },
      ],
      output_changes: {},
    };
    const d = buildPlanDigest(plan, META);
    assert.strictEqual(d.summary.driftDetected, true);
    assert.ok(d.drift && d.drift.length === 1);
    assert.strictEqual(d.drift[0].attributeChanges[0].path, 'tag');
  });

  it('noChanges is true for an empty plan and false when any resource acts', () => {
    assert.strictEqual(buildPlanDigest({ terraform_version: '1.9.5', resource_changes: [], output_changes: {} }, META).summary.noChanges, true);
    const noop = { terraform_version: '1.9.5', resource_changes: [{ address: 'r.n', type: 't', name: 'n', provider_name: 'p', change: change({ actions: ['no-op'], before: { x: 1 }, after: { x: 1 } }) }], output_changes: {} };
    assert.strictEqual(buildPlanDigest(noop, META).summary.noChanges, true);
  });

  it('masks sensitive output values via the after_sensitive mask', () => {
    const plan = {
      terraform_version: '1.9.5',
      resource_changes: [],
      output_changes: {
        secret_out: { actions: ['create'], before: null, after: 'TOPSECRET', after_unknown: false, before_sensitive: false, after_sensitive: true },
        plain_out: { actions: ['create'], before: null, after: 'visible', after_unknown: false, before_sensitive: false, after_sensitive: false },
      },
    };
    const d = buildPlanDigest(plan, META);
    const secret = d.outputChanges.find((o) => o.name === 'secret_out');
    const plain = d.outputChanges.find((o) => o.name === 'plain_out');
    assert.deepStrictEqual(secret?.value, { kind: 'sensitive' });
    assert.deepStrictEqual(plain?.value, { kind: 'value', json: '"visible"' });
    assert.ok(!JSON.stringify(d).includes('TOPSECRET'));
  });

  it('derives tool.version from terraform_version and echoes validated meta', () => {
    const d = buildPlanDigest({ terraform_version: '1.10.0', resource_changes: [], output_changes: {} }, META);
    assert.deepStrictEqual(d.tool, { name: 'terraform', version: '1.10.0' });
    assert.strictEqual(d.meta.name, 'terraform-plan');
    assert.strictEqual(d.meta.workingDirectory, 'infra');
    assert.strictEqual(d.producedBy.taskVersion, '0.0.0-test');
    assert.strictEqual(d.schemaVersion, 1);
  });

  it('tolerates malformed / missing input without throwing', () => {
    assert.doesNotThrow(() => buildPlanDigest(null, META));
    assert.doesNotThrow(() => buildPlanDigest({}, META));
    assert.doesNotThrow(() => buildPlanDigest({ resource_changes: 'nope' }, META));
    const d = buildPlanDigest({ resource_changes: [{ nonsense: true }, { address: '', change: {} }] }, META);
    assert.strictEqual(d.resources.length, 0, 'entries without an address are dropped');
  });

  describe('caps (§6)', () => {
    it('caps attribute changes per resource and notes the remainder', () => {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (let i = 0; i < MAX_ATTR_CHANGES_PER_RESOURCE + 25; i++) {
        before[`a${String(i).padStart(4, '0')}`] = i;
        after[`a${String(i).padStart(4, '0')}`] = i + 1;
      }
      const plan = { terraform_version: '1.9.5', resource_changes: [{ address: 'r.big', type: 't', name: 'big', provider_name: 'p', change: change({ actions: ['update'], before, after }) }], output_changes: {} };
      const d = buildPlanDigest(plan, META);
      assert.strictEqual(d.resources[0].attributeChanges.length, MAX_ATTR_CHANGES_PER_RESOURCE);
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('attribute changes for r.big capped')));
    });

    it('caps the resource list by action priority (destroy/replace survive) and notes the count', () => {
      const resource_changes = [];
      // MAX_RESOURCES creates first, then a handful of deletes that must survive.
      for (let i = 0; i < MAX_RESOURCES; i++) {
        resource_changes.push({ address: `r.create.${i}`, type: 't', name: `${i}`, provider_name: 'p', change: change({ actions: ['create'], before: null, after: { x: 1 } }) });
      }
      resource_changes.push({ address: 'r.delete.keep', type: 't', name: 'k', provider_name: 'p', change: change({ actions: ['delete'], before: { x: 1 }, after: null }) });
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes, output_changes: {} }, META);
      assert.strictEqual(d.resources.length, MAX_RESOURCES);
      assert.ok(d.resources.some((r) => r.address === 'r.delete.keep'), 'the delete survives truncation by priority');
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('resource list capped')));
    });

    it('does not set truncated for an ordinary plan within all caps', () => {
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes: [{ address: 'r.c', type: 't', name: 'c', provider_name: 'p', change: change({ actions: ['create'], before: null, after: { x: 1 } }) }], output_changes: {} }, META);
      assert.strictEqual(d.truncated, false);
      assert.strictEqual(d.truncationNotes, undefined);
    });

    it('caps the output list and notes the remainder (§3 DoS bound)', () => {
      const output_changes: Record<string, unknown> = {};
      for (let i = 0; i < MAX_OUTPUTS + 15; i++) {
        output_changes[`o${String(i).padStart(5, '0')}`] = { actions: ['create'], before: null, after: `v${i}`, after_unknown: false, before_sensitive: false, after_sensitive: false };
      }
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes: [], output_changes }, META);
      assert.strictEqual(d.outputChanges.length, MAX_OUTPUTS);
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('output list capped')));
    });

    it('caps the drift list and notes the remainder (§3 DoS bound)', () => {
      const resource_drift = [];
      for (let i = 0; i < MAX_DRIFT + 5; i++) {
        resource_drift.push({ address: `r.drift.${String(i).padStart(5, '0')}`, type: 't', name: `${i}`, provider_name: 'p', change: change({ actions: ['update'], before: { t: 'a' }, after: { t: 'b' } }) });
      }
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes: [], resource_drift, output_changes: {} }, META);
      assert.ok(d.drift && d.drift.length === MAX_DRIFT);
      assert.strictEqual(d.summary.driftDetected, true);
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('drift list capped')));
    });
  });

  describe('truncationNotes cap (§3 DoS bound)', () => {
    it('capNotes keeps the first MAX_NOTES and collapses the remainder into one count note', () => {
      const many = Array.from({ length: MAX_NOTES + 42 }, (_, i) => `note ${i}`);
      const capped = capNotes(many);
      assert.strictEqual(capped.length, MAX_NOTES + 1);
      assert.strictEqual(capped[MAX_NOTES - 1], `note ${MAX_NOTES - 1}`);
      assert.ok(capped[MAX_NOTES].includes('truncation notes capped at ' + MAX_NOTES));
      assert.ok(capped[MAX_NOTES].includes('42 more not shown'));
    });

    it('capNotes returns a copy unchanged when within the cap', () => {
      const few = ['a', 'b'];
      const out = capNotes(few);
      assert.deepStrictEqual(out, few);
      assert.notStrictEqual(out, few, 'returns a copy, not the same array reference');
    });

    it('a plan that generates more than MAX_NOTES notes bounds truncationNotes', () => {
      // MAX_NOTES+50 small resources, each carrying an unsafe attribute key ->
      // exactly one "dropped unsafe attribute key" note apiece (and a small digest
      // that stays well under the byte ceilings), so capNotes is the only thing
      // bounding the array: MAX_NOTES kept + one collapse note.
      const resource_changes = [];
      for (let i = 0; i < MAX_NOTES + 50; i++) {
        const after = JSON.parse('{"__proto__":{"x":1},"safe":1}');
        resource_changes.push({ address: `r.n.${String(i).padStart(5, '0')}`, type: 't', name: `${i}`, provider_name: 'p', change: change({ actions: ['create'], before: null, after }) });
      }
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes, output_changes: {} }, META);
      const noteCount = (d.truncationNotes ?? []).length;
      assert.strictEqual(noteCount, MAX_NOTES + 1, 'truncationNotes bounded to MAX_NOTES + one collapse note');
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('truncation notes capped')));
    });
  });

  describe('normalization / classification branches', () => {
    it('classifies output actions: update (delete+create), delete, and no-op fallback', () => {
      const plan = {
        terraform_version: '1.9.5',
        resource_changes: [],
        output_changes: {
          o_update: { actions: ['delete', 'create'], before: 'a', after: 'b', after_unknown: false, before_sensitive: false, after_sensitive: false },
          o_delete: { actions: ['delete'], before: 'a', after: null, after_unknown: false, before_sensitive: false, after_sensitive: false },
          o_noop: { actions: ['no-op'], before: 'a', after: 'a', after_unknown: false, before_sensitive: false, after_sensitive: false },
          o_weird: { actions: 'not-an-array', before: null, after: 'x', after_unknown: false, before_sensitive: false, after_sensitive: false },
        },
      };
      const d = buildPlanDigest(plan, META);
      const byName = Object.fromEntries(d.outputChanges.map((o) => [o.name, o.action]));
      assert.strictEqual(byName.o_update, 'update');
      assert.strictEqual(byName.o_delete, 'delete');
      assert.strictEqual(byName.o_noop, 'no-op');
      assert.strictEqual(byName.o_weird, 'no-op');
    });

    it('normalizes non-array / unrecognized actions to ["no-op"]', () => {
      const plan = {
        terraform_version: '1.9.5',
        resource_changes: [
          { address: 'r.bad', type: 't', name: 'b', provider_name: 'p', change: change({ actions: 'garbage', before: { x: 1 }, after: { x: 1 } }) },
          { address: 'r.unk', type: 't', name: 'u', provider_name: 'p', change: change({ actions: ['frobnicate'], before: { x: 1 }, after: { x: 1 } }) },
        ],
        output_changes: {},
      };
      const d = buildPlanDigest(plan, META);
      assert.deepStrictEqual(d.resources[0].actions, ['no-op']);
      assert.deepStrictEqual(d.resources[1].actions, ['no-op']);
    });

    it('renders replace_paths with indexed and nested segments', () => {
      const plan = {
        terraform_version: '1.9.5',
        resource_changes: [
          { address: 'r.x', type: 't', name: 'x', provider_name: 'p', change: change({ actions: ['delete', 'create'], before: { a: 1 }, after: { a: 2 }, replace_paths: [['tags', 0, 'Name'], 'not-an-array'] }) },
        ],
        output_changes: {},
      };
      const d = buildPlanDigest(plan, META);
      assert.deepStrictEqual(d.resources[0].replacePaths, ['tags[0].Name']);
    });

    it('ignores an action_reason of "none" and non-string types/names', () => {
      const plan = {
        terraform_version: '1.9.5',
        resource_changes: [{ address: 'r.c', type: 123, name: null, provider_name: undefined, action_reason: 'none', change: change({ actions: ['create'], before: null, after: { x: 1 } }) }],
        output_changes: {},
      };
      const d = buildPlanDigest(plan, META);
      assert.strictEqual(d.resources[0].actionReason, undefined);
      assert.strictEqual(d.resources[0].type, '');
      assert.strictEqual(d.resources[0].name, '');
      assert.strictEqual(d.resources[0].providerName, '');
    });

    it('drops non-object resource_changes / resource_drift entries', () => {
      const plan = {
        terraform_version: '1.9.5',
        resource_changes: ['a string', 42, null],
        resource_drift: ['junk', { address: 'r.d', type: 't', name: 'd', provider_name: 'p', change: change({ actions: ['update'], before: { t: 'a' }, after: { t: 'b' } }) }],
        output_changes: {},
      };
      const d = buildPlanDigest(plan, META);
      assert.strictEqual(d.resources.length, 0);
      assert.ok(d.drift && d.drift.length === 1);
    });

    it('detects an unknown leaf nested inside an array (anyTrue array recursion)', () => {
      const plan = {
        terraform_version: '1.9.5',
        resource_changes: [{ address: 'r.a', type: 't', name: 'a', provider_name: 'p', change: change({ actions: ['update'], before: { list: ['x', 'y'] }, after: { list: ['x', null] }, after_unknown: { list: [false, true] } }) }],
        output_changes: {},
      };
      const d = buildPlanDigest(plan, META);
      const attr = d.resources[0].attributeChanges.find((a) => a.path === 'list');
      assert.deepStrictEqual(attr?.after, { kind: 'value', json: '["x","(known after apply)"]' });
    });

    it('echoes optional stage/job meta when provided', () => {
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes: [], output_changes: {} }, { ...META, stage: 'Deploy', job: 'apply_job' });
      assert.strictEqual(d.meta.stage, 'Deploy');
      assert.strictEqual(d.meta.job, 'apply_job');
    });

    it('preserves destroy/replace over update/read/no-op when the resource list is capped', () => {
      const resource_changes = [];
      for (let i = 0; i < MAX_RESOURCES; i++) {
        const kind = i % 3;
        const actions = kind === 0 ? ['update'] : kind === 1 ? ['read'] : ['no-op'];
        resource_changes.push({ address: `r.pad.${i}`, type: 't', name: `${i}`, provider_name: 'p', change: change({ actions, before: { x: 1 }, after: kind === 0 ? { x: 2 } : { x: 1 } }) });
      }
      resource_changes.push({ address: 'r.replace.keep', type: 't', name: 'k', provider_name: 'p', change: change({ actions: ['delete', 'create'], before: { x: 1 }, after: { x: 2 } }) });
      const d = buildPlanDigest({ terraform_version: '1.9.5', resource_changes, output_changes: {} }, META);
      assert.strictEqual(d.resources.length, MAX_RESOURCES);
      assert.ok(d.resources.some((r) => r.address === 'r.replace.keep'), 'the replace survives by action priority');
    });
  });

  it('drops prototype-pollution attribute keys and notes them', () => {
    const after = JSON.parse('{"__proto__":{"x":1},"safe":"v"}');
    const plan = { terraform_version: '1.9.5', resource_changes: [{ address: 'r.p', type: 't', name: 'p', provider_name: 'p', change: change({ actions: ['create'], before: null, after }) }], output_changes: {} };
    const d = buildPlanDigest(plan, META);
    const paths = d.resources[0].attributeChanges.map((a) => a.path);
    assert.ok(!paths.includes('__proto__'));
    assert.ok(paths.includes('safe'));
    assert.strictEqual(({} as Record<string, unknown>).x, undefined);
  });

  describe('planMode destroy marker (§7.1 — destroy reuses PlanDigest)', () => {
    // A destroy plan's resource_changes are all deletes; the marker is taken
    // FROM THE CALLER, never inferred from counts, so an all-delete NORMAL plan
    // is not mislabeled.
    const destroyPlan = {
      terraform_version: '1.9.5',
      resource_changes: [
        { address: 'aws_db_instance.main', type: 'aws_db_instance', name: 'main', provider_name: 'p', change: change({ actions: ['delete'], before: { id: 'db-1' }, after: null }) },
      ],
      output_changes: {},
    };

    it('sets planMode="destroy" when the caller passes {mode:"destroy"}', () => {
      const d = buildPlanDigest(destroyPlan, META, { mode: 'destroy' });
      assert.strictEqual(d.planMode, 'destroy');
      // marker is presentation-only: the deletes still appear as delete actions.
      assert.deepStrictEqual(d.resources[0].actions, ['delete']);
      assert.strictEqual(d.summary.destroy, 1);
    });

    it('leaves planMode absent by default (normal plan, unchanged contract)', () => {
      assert.strictEqual(buildPlanDigest(destroyPlan, META).planMode, undefined);
      assert.strictEqual(buildPlanDigest(destroyPlan, META, {}).planMode, undefined);
    });

    it('leaves planMode absent for {mode:"plan"} (default === absent)', () => {
      assert.strictEqual(buildPlanDigest(destroyPlan, META, { mode: 'plan' }).planMode, undefined);
    });

    it('does NOT infer destroy from an all-delete plan built without the marker', () => {
      // identical all-delete input, no mode option -> NOT labeled a destroy.
      const d = buildPlanDigest(destroyPlan, META);
      assert.strictEqual(d.planMode, undefined, 'all-delete alone must not imply destroy');
    });
  });
});
