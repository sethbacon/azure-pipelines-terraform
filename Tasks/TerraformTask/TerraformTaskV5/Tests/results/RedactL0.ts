import * as assert from 'assert';
import {
  redactValue,
  newRedactContext,
  stableStringify,
  utf8ByteLength,
  deepEqual,
  serializeDigest,
  capDigestBytes,
} from '../../src/results/redact';
import { PlanDigest, ApplyDigest, StateDigest, StateResource } from '../../src/results/digest-schema';
import { MAX_REDACTED_VALUE_BYTES, SOFT_MAX_DIGEST_BYTES, HARD_MAX_DIGEST_BYTES } from '../../src/results/caps';

// The exhaustive redaction matrix (design §12.2). Redaction is the #1 control:
// a gap here is a secret disclosure, so every sensitivity source, the
// fail-closed shape-mismatch rule, the prototype-pollution guard, the size cap,
// and determinism each have a direct assertion.
describe('redactValue — redaction core', () => {
  function ctx(maxValueBytes?: number) {
    return newRedactContext(maxValueBytes !== undefined ? { maxValueBytes } : undefined);
  }

  describe('non-sensitive values -> {kind:"value"}', () => {
    it('redacts a primitive string to bounded JSON', () => {
      const rv = redactValue('hello', false, false, ctx());
      assert.deepStrictEqual(rv, { kind: 'value', json: '"hello"' });
    });

    it('redacts a number/boolean/null', () => {
      assert.deepStrictEqual(redactValue(42, false, false, ctx()), { kind: 'value', json: '42' });
      assert.deepStrictEqual(redactValue(true, false, false, ctx()), { kind: 'value', json: 'true' });
      assert.deepStrictEqual(redactValue(null, false, false, ctx()), { kind: 'value', json: 'null' });
    });

    it('coerces an undefined leaf (attribute absent on one diff side) to JSON null', () => {
      assert.deepStrictEqual(redactValue(undefined, false, false, ctx()), { kind: 'value', json: 'null' });
      assert.deepStrictEqual(redactValue([undefined], false, false, ctx()), { kind: 'value', json: '[null]' });
    });

    it('redacts a collection with sorted-key JSON', () => {
      const rv = redactValue({ b: 1, a: [2, 3] }, false, false, ctx());
      assert.deepStrictEqual(rv, { kind: 'value', json: '{"a":[2,3],"b":1}' });
    });
  });

  describe('sensitivity sources (§5.2.1)', () => {
    it('after_sensitive:true at a leaf -> {kind:"sensitive"} and the value never appears', () => {
      const c = ctx();
      const rv = redactValue('hunter2', true, false, c);
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
      assert.ok(!JSON.stringify(rv).includes('hunter2'), 'secret must not appear in output');
    });

    it('before_sensitive form (whole-value boolean mask) masks the before value', () => {
      const rv = redactValue('old-secret', true, false, ctx());
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
    });

    it('sensitive_values form (shape-parallel object mask) masks nested leaves only', () => {
      const c = ctx();
      // Secret values are chosen so they are NOT substrings of any key name,
      // so the leak check cannot false-positive on a key like "token".
      const rv = redactValue(
        { user: 'adminuser', password: 'PWLEAF_secret', nested: { token: 'TOKLEAF_secret', keep: 'keepval' } },
        { password: true, nested: { token: true } },
        false,
        c,
      );
      assert.strictEqual(rv.kind, 'value');
      const json = (rv as { json: string }).json;
      assert.ok(!json.includes('PWLEAF_secret'), 'sensitive leaf must be masked');
      assert.ok(!json.includes('TOKLEAF_secret'), 'nested sensitive leaf must be masked');
      assert.ok(json.includes('adminuser'), 'non-sensitive sibling preserved');
      assert.ok(json.includes('keepval'), 'non-sensitive nested sibling preserved');
      assert.ok(json.includes('(sensitive)'), 'masked leaves become the sentinel');
    });

    it('output sensitivity (whole-output boolean) masks the whole value', () => {
      assert.deepStrictEqual(redactValue('OUTPUT_SECRET', true, false, ctx()), { kind: 'sensitive' });
    });

    it('partial-sensitive array masks only the sensitive index', () => {
      const rv = redactValue([1, 'SECRET', 3], [false, true, false], false, ctx());
      assert.deepStrictEqual(rv, { kind: 'value', json: '[1,"(sensitive)",3]' });
    });
  });

  describe('unknown source (§5.2.3)', () => {
    it('after_unknown:true -> {kind:"unknown"}', () => {
      assert.deepStrictEqual(redactValue(null, false, true, ctx()), { kind: 'unknown' });
    });

    it('sensitivity wins over unknown at the same leaf', () => {
      assert.deepStrictEqual(redactValue('x', true, true, ctx()), { kind: 'sensitive' });
    });

    it('partial-unknown collection substitutes the unknown sentinel', () => {
      const rv = redactValue({ a: 1, b: 2 }, false, { b: true }, ctx());
      assert.deepStrictEqual(rv, { kind: 'value', json: '{"a":1,"b":"(known after apply)"}' });
    });
  });

  describe('FAIL CLOSED on shape mismatch (§2.8 — the single most important rule)', () => {
    it('container sensitivity mask over a scalar value -> masked + note', () => {
      const c = ctx();
      const rv = redactValue('scalar', { inner: true }, false, c);
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
      assert.ok(c.notes.some((n) => n.includes('mask shape mismatch')), 'records an observable note');
    });

    it('container unknown mask over a scalar value -> masked', () => {
      assert.deepStrictEqual(redactValue(7, false, { inner: true }, ctx()), { kind: 'sensitive' });
    });

    it('object mask over an array value -> masked', () => {
      const c = ctx();
      const rv = redactValue([1, 2, 3], { 0: true }, false, c);
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
      assert.ok(c.notes.length > 0);
    });

    it('array mask over an object value -> masked', () => {
      const c = ctx();
      const rv = redactValue({ a: 1 }, [true], false, c);
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
      assert.ok(c.notes.length > 0);
    });

    it('sensitivity mask array SHORTER than the value array -> masked, no trailing leak', () => {
      // The mask marks index 0 sensitive but says nothing about index 1. A short
      // mask must never let the un-described trailing element leak in cleartext:
      // fail the WHOLE value closed (§2.8).
      const c = ctx();
      const rv = redactValue([1, 'SECRET'], [true], false, c);
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
      assert.ok(!JSON.stringify(rv).includes('SECRET'), 'trailing element must not leak');
      assert.ok(c.notes.some((n) => n.includes('array length mismatch')), 'records an observable note');
    });

    it('unknown mask array of a different length than the value array -> masked', () => {
      const c = ctx();
      const rv = redactValue([1, 2, 3], false, [false, false], c);
      assert.deepStrictEqual(rv, { kind: 'sensitive' });
      assert.ok(c.notes.some((n) => n.includes('array length mismatch')));
    });

    it('a full-length parallel mask array still redacts per element (no false positive)', () => {
      const rv = redactValue([1, 'SECRET', 3], [false, true, false], false, ctx());
      assert.deepStrictEqual(rv, { kind: 'value', json: '[1,"(sensitive)",3]' });
    });

    it('mismatch nested inside a collection masks only that leaf, not the sibling', () => {
      // value.a is a scalar but its mask is a container -> that leaf fails closed;
      // value.b is a clean scalar and survives.
      const rv = redactValue({ a: 'leak-me', b: 'keep-me' }, { a: { deep: true } }, false, ctx());
      assert.strictEqual(rv.kind, 'value');
      const json = (rv as { json: string }).json;
      assert.ok(!json.includes('leak-me'), 'mismatched leaf masked');
      assert.ok(json.includes('keep-me'), 'clean sibling preserved');
      assert.ok(json.includes('(sensitive)'));
    });
  });

  describe('prototype-pollution guard (§2.5)', () => {
    it('drops __proto__ / constructor / prototype keys and never pollutes Object.prototype', () => {
      const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2},"safe":"ok"}');
      const c = ctx();
      const rv = redactValue(evil, false, false, c);
      assert.strictEqual(rv.kind, 'value');
      const json = (rv as { json: string }).json;
      assert.strictEqual(json, '{"safe":"ok"}');
      assert.strictEqual(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype must not be polluted');
      assert.ok(c.notes.some((n) => n.includes('unsafe key')), 'records dropped-key notes');
    });
  });

  describe('size cap (§6)', () => {
    it('a value just over the per-value byte cap -> {kind:"omitted",reason:"too-large"}', () => {
      const big = 'x'.repeat(MAX_REDACTED_VALUE_BYTES + 10);
      const c = ctx();
      const rv = redactValue(big, false, false, c);
      assert.deepStrictEqual(rv, { kind: 'omitted', reason: 'too-large' });
      assert.ok(c.notes.some((n) => n.includes('over per-value size cap')));
    });

    it('a value exactly at the cap is kept', () => {
      // JSON-encoded length = content + 2 quotes; choose content so json == cap.
      const content = 'y'.repeat(MAX_REDACTED_VALUE_BYTES - 2);
      const rv = redactValue(content, false, false, ctx());
      assert.strictEqual(rv.kind, 'value');
    });
  });

  describe('determinism (§2.6)', () => {
    it('identical input -> byte-identical output regardless of key insertion order', () => {
      const a = redactValue({ z: 1, a: 2, m: { y: 3, b: 4 } }, false, false, ctx());
      const b = redactValue({ m: { b: 4, y: 3 }, a: 2, z: 1 }, false, false, ctx());
      assert.deepStrictEqual(a, b);
      assert.strictEqual((a as { json: string }).json, (b as { json: string }).json);
    });
  });
});

describe('shared serialization / size utilities', () => {
  it('stableStringify sorts object keys lexicographically at every level', () => {
    assert.strictEqual(stableStringify({ b: { d: 1, c: 2 }, a: [3, { f: 4, e: 5 }] }), '{"a":[3,{"e":5,"f":4}],"b":{"c":2,"d":1}}');
  });

  it('utf8ByteLength counts UTF-8 bytes, not code units', () => {
    assert.strictEqual(utf8ByteLength('abc'), 3);
    assert.strictEqual(utf8ByteLength('é'), 2); // é is 2 UTF-8 bytes
  });

  it('deepEqual compares JSON structures', () => {
    assert.ok(deepEqual({ a: [1, 2], b: null }, { b: null, a: [1, 2] }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
    assert.ok(!deepEqual([1, 2], [1, 2, 3]));
  });
});

describe('capDigestBytes — digest-level byte ceilings (§3)', () => {
  function planWithAttrs(n: number): PlanDigest {
    const resources = [];
    for (let i = 0; i < n; i++) {
      resources.push({
        address: `res.${i}`,
        type: 'x',
        name: `${i}`,
        providerName: 'p',
        actions: ['update'] as PlanDigest['resources'][number]['actions'],
        attributeChanges: [{ path: 'big', before: { kind: 'value', json: '"' + 'a'.repeat(200) + '"' } as const, after: { kind: 'value', json: '"b"' } as const }],
      });
    }
    return {
      schemaVersion: 1,
      kind: 'plan',
      producedBy: { task: 'TerraformTaskV5', taskVersion: 't' },
      tool: { name: 'terraform', version: '1' },
      meta: { name: 'n', createdIso: 'i' },
      truncated: false,
      summary: { add: 0, change: n, destroy: 0, replace: 0, read: 0, noChanges: false, driftDetected: false },
      resources,
      outputChanges: [],
    };
  }

  it('within the soft ceiling: returned unchanged', () => {
    const d = planWithAttrs(3);
    const out = capDigestBytes(d, 10 * 1024 * 1024, 20 * 1024 * 1024);
    assert.strictEqual(out.resources[0].attributeChanges.length, 1);
    assert.strictEqual(out.truncated, false);
  });

  it('over soft ceiling: drops attributeChanges arrays, keeps rows + summary, sets truncated', () => {
    const d = planWithAttrs(50);
    const out = capDigestBytes(d, 2000, 20 * 1024 * 1024);
    assert.strictEqual(out.resources.length, 50, 'resource rows preserved');
    assert.ok(out.resources.every((r) => r.attributeChanges.length === 0), 'attribute arrays dropped');
    assert.strictEqual(out.truncated, true);
    assert.ok((out.truncationNotes ?? []).some((n) => n.includes('soft size ceiling')));
  });

  it('over hard ceiling: collapses to a summary-only digest', () => {
    const d = planWithAttrs(50);
    const out = capDigestBytes(d, 500, 800);
    assert.strictEqual(out.resources.length, 0, 'summary-only drops resource rows');
    assert.strictEqual(out.outputChanges.length, 0);
    assert.strictEqual(out.truncated, true);
    assert.deepStrictEqual(out.summary, d.summary, 'summary counts preserved');
    assert.ok((out.truncationNotes ?? []).some((n) => n.includes('hard size ceiling')));
  });

  it('apply digest over soft ceiling drops diagnostic detail', () => {
    const diagnostics = [];
    for (let i = 0; i < 40; i++) diagnostics.push({ severity: 'error' as const, summary: `e${i}`, detail: 'd'.repeat(200) });
    const d: ApplyDigest = {
      schemaVersion: 1,
      kind: 'apply',
      producedBy: { task: 'TerraformTaskV5', taskVersion: 't' },
      tool: { name: 'terraform', version: '1' },
      meta: { name: 'n', createdIso: 'i' },
      truncated: false,
      outcome: 'failed',
      summary: { add: 0, change: 0, destroy: 0 },
      resources: [],
      diagnostics,
      outputs: [],
    };
    const out = capDigestBytes(d, 2000, 20 * 1024 * 1024);
    assert.ok(out.diagnostics.every((x) => x.detail === undefined), 'diagnostic detail dropped');
    assert.strictEqual(out.truncated, true);
  });

  // Regression (§3): a StateDigest must reduce like plan/apply, not crash. Before
  // the fix, the soft-ceiling branch routed every non-plan digest (including
  // kind:"state") into dropApplyDiagnosticDetail, which iterates `d.diagnostics`
  // — a field a StateDigest does not have — throwing `d.diagnostics is not
  // iterable` and failing the whole task on any large real-world state.
  function stateWithAttrs(resourceCount: number, attrsPerResource: number, valueBytes: number): StateDigest {
    const resources: StateResource[] = [];
    for (let i = 0; i < resourceCount; i++) {
      const attributes: StateResource['attributes'] = [];
      for (let j = 0; j < attrsPerResource; j++) {
        attributes.push({ name: `attr${j}`, value: { kind: 'value', json: '"' + 'a'.repeat(valueBytes) + '"' } });
      }
      resources.push({ address: `res.${i}`, type: 'x', name: `${i}`, providerName: 'p', mode: 'managed', attributes });
    }
    return {
      schemaVersion: 1,
      kind: 'state',
      producedBy: { task: 'TerraformTaskV5', taskVersion: 't' },
      tool: { name: 'terraform', version: '1' },
      meta: { name: 'n', createdIso: 'i' },
      truncated: false,
      resources,
      outputs: [],
      summary: { resourceCount, dataSourceCount: 0 },
    };
  }

  it('state digest over the REAL soft ceiling: no throw, drops attributes arrays, keeps rows + summary', () => {
    // ~8 resources x 200 attrs x ~4KB each ≈ 6.5MB > SOFT (5MB), < HARD (12MB):
    // a realistic large state (IAM policies, base64 user_data, cert bundles).
    const d = stateWithAttrs(8, 200, 4096);
    assert.ok(utf8ByteLength(serializeDigest(d)) > SOFT_MAX_DIGEST_BYTES, 'fixture must actually exceed the soft ceiling');
    assert.ok(utf8ByteLength(serializeDigest(d)) < HARD_MAX_DIGEST_BYTES, 'fixture must stay under the hard ceiling');
    let out!: StateDigest;
    assert.doesNotThrow(() => {
      out = capDigestBytes(d, SOFT_MAX_DIGEST_BYTES, HARD_MAX_DIGEST_BYTES);
    });
    assert.strictEqual(out.resources.length, 8, 'resource rows preserved');
    assert.ok(out.resources.every((r) => r.attributes.length === 0), 'attribute arrays dropped');
    assert.strictEqual(out.truncated, true);
    assert.ok((out.truncationNotes ?? []).some((n) => n.includes('soft size ceiling')));
  });

  it('state digest over hard ceiling: collapses to a state summary-only digest', () => {
    const d = stateWithAttrs(20, 5, 200);
    const out = capDigestBytes(d, 500, 800);
    assert.strictEqual(out.kind, 'state', 'stays a state digest');
    assert.strictEqual(out.resources.length, 0, 'summary-only drops resource rows');
    assert.strictEqual(out.outputs.length, 0);
    assert.strictEqual(out.truncated, true);
    assert.deepStrictEqual(out.summary, d.summary, 'summary counts preserved');
    assert.ok((out.truncationNotes ?? []).some((n) => n.includes('hard size ceiling')));
  });

  it('serializeDigest is deterministic pretty JSON', () => {
    const d = planWithAttrs(1);
    assert.strictEqual(serializeDigest(d), serializeDigest(d));
  });
});
