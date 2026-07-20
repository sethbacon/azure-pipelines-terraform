import * as assert from 'assert';
import { buildStateDigest } from '../../src/results/state-digest';
import { DigestBuildMeta } from '../../src/results/plan-digest';
import { serializeDigest } from '../../src/results/redact';
import { MAX_STATE_RESOURCES, MAX_STATE_ATTRS_PER_RESOURCE, MAX_OUTPUTS } from '../../src/results/caps';

// STATE INVENTORY DIGEST MATRIX (design §12.2, spec §7.2/§7.3/§7.4). The state
// path is security-critical: a `sensitive_values` leaf that escapes redaction is
// a secret disclosure, so every sensitivity source, the fail-closed shape-
// mismatch rule, the module-flattening walk, the mode split, the caps, and
// determinism each have a direct assertion.

const META: DigestBuildMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-state',
  workingDirectory: 'infra',
  createdIso: '2026-07-15T00:00:00Z',
};

/** Minimal `terraform show -json` STATE envelope around a root_module. */
function state(rootModule: Record<string, unknown>, outputs?: Record<string, unknown>) {
  return {
    format_version: '1.0',
    terraform_version: '1.9.5',
    values: {
      ...(outputs !== undefined ? { outputs } : {}),
      root_module: rootModule,
    },
  };
}

function resource(overrides: Record<string, unknown>) {
  return {
    address: 'aws_s3_bucket.b',
    mode: 'managed',
    type: 'aws_s3_bucket',
    name: 'b',
    provider_name: 'registry.terraform.io/hashicorp/aws',
    values: {},
    sensitive_values: {},
    ...overrides,
  };
}

describe('buildStateDigest', () => {
  it('builds a managed resource inventory with redacted current attribute values', () => {
    const d = buildStateDigest(
      state({
        resources: [
          resource({
            address: 'aws_s3_bucket.b',
            values: { bucket: 'my-bucket', versioning: true, tags: { env: 'prod' } },
            sensitive_values: {},
          }),
        ],
      }),
      META,
    );
    assert.strictEqual(d.kind, 'state');
    assert.strictEqual(d.schemaVersion, 1);
    assert.strictEqual(d.resources.length, 1);
    const r = d.resources[0];
    assert.strictEqual(r.address, 'aws_s3_bucket.b');
    assert.strictEqual(r.mode, 'managed');
    assert.strictEqual(r.moduleAddress, undefined, 'root-module resources carry no moduleAddress');
    // attributes are sorted lexicographically and carry current values.
    assert.deepStrictEqual(r.attributes.map((a) => a.name), ['bucket', 'tags', 'versioning']);
    assert.deepStrictEqual(r.attributes.find((a) => a.name === 'bucket')!.value, { kind: 'value', json: '"my-bucket"' });
    assert.deepStrictEqual(r.attributes.find((a) => a.name === 'tags')!.value, { kind: 'value', json: '{"env":"prod"}' });
    assert.deepStrictEqual(d.summary, { resourceCount: 1, dataSourceCount: 0 });
    assert.strictEqual(d.truncated, false);
  });

  it('masks a sensitive_values leaf to {kind:"sensitive"} and never serializes the secret', () => {
    const SECRET = 'STATESECRET_pw_abc123';
    const d = buildStateDigest(
      state({
        resources: [
          resource({
            address: 'aws_db_instance.main',
            type: 'aws_db_instance',
            name: 'main',
            values: { username: 'admin', password: SECRET, port: 5432 },
            sensitive_values: { password: true },
          }),
        ],
      }),
      META,
    );
    const attrs = d.resources[0].attributes;
    assert.deepStrictEqual(attrs.find((a) => a.name === 'password')!.value, { kind: 'sensitive' });
    assert.deepStrictEqual(attrs.find((a) => a.name === 'username')!.value, { kind: 'value', json: '"admin"' });
    // the tripwire: the raw secret literal appears NOWHERE in the serialized digest.
    assert.ok(!serializeDigest(d).includes(SECRET), 'SECURITY: sensitive state value leaked');
  });

  it('masks a sensitive leaf NESTED inside an object attribute (shape-parallel mask)', () => {
    const SECRET = 'NESTEDSECRET_tok_9f3k';
    const d = buildStateDigest(
      state({
        resources: [
          resource({
            address: 'aws_instance.web',
            type: 'aws_instance',
            name: 'web',
            values: { config: { host: 'db.internal', token: SECRET }, ports: [80, 443] },
            sensitive_values: { config: { token: true } },
          }),
        ],
      }),
      META,
    );
    const config = d.resources[0].attributes.find((a) => a.name === 'config')!.value;
    assert.deepStrictEqual(config, { kind: 'value', json: '{"host":"db.internal","token":"(sensitive)"}' });
    assert.ok(!serializeDigest(d).includes(SECRET));
  });

  it('flattens child_modules into module-prefixed addresses (recursive walk, §7.2)', () => {
    const d = buildStateDigest(
      state({
        resources: [resource({ address: 'aws_vpc.root', type: 'aws_vpc', name: 'root' })],
        child_modules: [
          {
            address: 'module.db',
            resources: [resource({ address: 'module.db.aws_db_instance.this', type: 'aws_db_instance', name: 'this' })],
            child_modules: [
              {
                address: 'module.db.module.inner',
                resources: [resource({ address: 'module.db.module.inner.aws_kms_key.k', type: 'aws_kms_key', name: 'k' })],
              },
            ],
          },
        ],
      }),
      META,
    );
    const byAddr = Object.fromEntries(d.resources.map((r) => [r.address, r]));
    assert.deepStrictEqual(Object.keys(byAddr).sort(), [
      'aws_vpc.root',
      'module.db.aws_db_instance.this',
      'module.db.module.inner.aws_kms_key.k',
    ]);
    assert.strictEqual(byAddr['aws_vpc.root'].moduleAddress, undefined);
    assert.strictEqual(byAddr['module.db.aws_db_instance.this'].moduleAddress, 'module.db');
    assert.strictEqual(byAddr['module.db.module.inner.aws_kms_key.k'].moduleAddress, 'module.db.module.inner');
    assert.strictEqual(d.summary.resourceCount, 3);
  });

  it('splits managed vs data resources in the summary counts', () => {
    const d = buildStateDigest(
      state({
        resources: [
          resource({ address: 'aws_s3_bucket.b', mode: 'managed' }),
          resource({ address: 'data.aws_ami.ubuntu', mode: 'data', type: 'aws_ami', name: 'ubuntu' }),
          resource({ address: 'data.aws_caller_identity.me', mode: 'data', type: 'aws_caller_identity', name: 'me' }),
        ],
      }),
      META,
    );
    assert.deepStrictEqual(d.summary, { resourceCount: 1, dataSourceCount: 2 });
    assert.strictEqual(d.resources.find((r) => r.address === 'data.aws_ami.ubuntu')!.mode, 'data');
  });

  it('masks a sensitive OUTPUT whole and redacts a plain output (§7.3, no action field)', () => {
    const OUT_SECRET = 'OUTPUTSTATESECRET_xyz';
    const d = buildStateDigest(
      state({ resources: [] }, {
        db_password: { value: OUT_SECRET, type: 'string', sensitive: true },
        region: { value: 'us-east-1', type: 'string', sensitive: false },
      }),
      META,
    );
    const byName = Object.fromEntries(d.outputs.map((o) => [o.name, o]));
    assert.deepStrictEqual(byName.db_password.value, { kind: 'sensitive' });
    assert.deepStrictEqual(byName.region.value, { kind: 'value', json: '"us-east-1"' });
    // OutputValue has NO `action` field (state is not a change set).
    assert.ok(!('action' in byName.db_password));
    assert.ok(!serializeDigest(d).includes(OUT_SECRET));
  });

  describe('FAIL CLOSED on shape mismatch (§2.8 / §7.2) — masks, never leaks', () => {
    it('a container sensitive_values mask over a scalar value masks fail-closed and notes it', () => {
      const SECRET = 'SHAPEMISMATCHSECRET_scalar';
      const d = buildStateDigest(
        state({
          resources: [
            resource({
              address: 'aws_x.y',
              values: { field: SECRET },
              // object mask over a scalar value -> shape mismatch
              sensitive_values: { field: { nested: true } },
            }),
          ],
        }),
        META,
      );
      assert.deepStrictEqual(d.resources[0].attributes.find((a) => a.name === 'field')!.value, { kind: 'sensitive' });
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('mask shape mismatch')));
      assert.ok(!serializeDigest(d).includes(SECRET), 'SECURITY: value leaked on shape mismatch');
    });

    it('an array-length mismatch in the mask masks the whole array fail-closed', () => {
      const SECRET = 'SHAPEMISMATCHSECRET_arraylen';
      const d = buildStateDigest(
        state({
          resources: [
            resource({
              address: 'aws_x.y',
              values: { ports: [22, SECRET, 443] },
              sensitive_values: { ports: [false, true] }, // length 2 != value length 3
            }),
          ],
        }),
        META,
      );
      assert.deepStrictEqual(d.resources[0].attributes.find((a) => a.name === 'ports')!.value, { kind: 'sensitive' });
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('array length mismatch')));
      assert.ok(!serializeDigest(d).includes(SECRET));
    });
  });

  it('never emits {kind:"unknown"} — state is fully materialized (§7.2)', () => {
    const d = buildStateDigest(
      state({
        resources: [resource({ address: 'aws_x.y', values: { a: 1, b: 'two', c: [1, 2], d: { e: 'f' } } })],
      }),
      META,
    );
    assert.ok(!serializeDigest(d).includes('"unknown"'), 'a StateDigest must never contain an unknown variant');
    assert.ok(!serializeDigest(d).includes('known after apply'));
  });

  it('drops prototype-pollution attribute keys and notes them', () => {
    const values = JSON.parse('{"__proto__":{"x":1},"constructor":1,"safe":"v"}');
    const d = buildStateDigest(
      state({ resources: [resource({ address: 'aws_x.y', values })] }),
      META,
    );
    const names = d.resources[0].attributes.map((a) => a.name);
    assert.ok(!names.includes('__proto__'));
    assert.ok(!names.includes('constructor'));
    assert.ok(names.includes('safe'));
    assert.ok((d.truncationNotes ?? []).some((n) => n.includes('unsafe attribute key')));
    assert.strictEqual(({} as Record<string, unknown>).x, undefined, 'Object.prototype not polluted');
  });

  it('drops a prototype-pollution OUTPUT key and notes it', () => {
    const outputs = JSON.parse('{"__proto__":{"value":"x","sensitive":false},"ok":{"value":"v","type":"string","sensitive":false}}');
    const d = buildStateDigest(state({ resources: [] }, outputs), META);
    assert.deepStrictEqual(d.outputs.map((o) => o.name), ['ok']);
    assert.ok((d.truncationNotes ?? []).some((n) => n.includes('unsafe output key')));
  });

  it('sanitizes the publish name and records an observable note', () => {
    const d = buildStateDigest(state({ resources: [] }), { ...META, name: 'terraform-state\r\n]evil' });
    assert.ok(!d.meta.name.includes('\n') && !d.meta.name.includes(']'), 'injection chars stripped from the attachment name');
    assert.strictEqual(d.truncated, true);
    assert.ok((d.truncationNotes ?? []).some((n) => n.includes('publish name sanitized')));
  });

  it('keeps a child module resource under the PARENT path when the child omits its address (no silent reparent to root)', () => {
    const d = buildStateDigest(
      state({
        resources: [],
        child_modules: [
          {
            address: 'module.outer',
            resources: [resource({ address: 'module.outer.aws_x.y', type: 'aws_x', name: 'y' })],
            // malformed inner child: address omitted -> resources stay under module.outer.
            child_modules: [
              { resources: [resource({ address: 'module.outer.aws_z.w', type: 'aws_z', name: 'w' })] },
            ],
          },
        ],
      }),
      META,
    );
    const byAddr = Object.fromEntries(d.resources.map((r) => [r.address, r.moduleAddress]));
    assert.strictEqual(byAddr['module.outer.aws_x.y'], 'module.outer');
    // the address-less inner module's resource inherits the parent path, not root.
    assert.strictEqual(byAddr['module.outer.aws_z.w'], 'module.outer');
  });

  describe('empty / malformed input', () => {
    it('empty state -> resourceCount 0, no resources, no throw', () => {
      assert.doesNotThrow(() => buildStateDigest(null, META));
      assert.doesNotThrow(() => buildStateDigest({}, META));
      const d = buildStateDigest(state({ resources: [] }), META);
      assert.strictEqual(d.resources.length, 0);
      assert.deepStrictEqual(d.summary, { resourceCount: 0, dataSourceCount: 0 });
      assert.strictEqual(d.truncated, false);
      assert.strictEqual(d.outputs.length, 0);
    });

    it('tolerates a missing values/root_module and non-array resources', () => {
      assert.strictEqual(buildStateDigest({ values: {} }, META).resources.length, 0);
      assert.strictEqual(buildStateDigest({ values: { root_module: { resources: 'nope' } } }, META).resources.length, 0);
    });

    it('drops resource entries without a string address', () => {
      const d = buildStateDigest(
        state({ resources: ['a string', 42, null, { type: 't', name: 'n' }, resource({ address: 'aws_ok.k' })] }),
        META,
      );
      assert.strictEqual(d.resources.length, 1);
      assert.strictEqual(d.resources[0].address, 'aws_ok.k');
    });

    it('defaults a malformed/absent mode to "managed" and coerces missing identity fields', () => {
      const d = buildStateDigest(
        state({ resources: [{ address: 'aws_x.y', values: {}, sensitive_values: {} }] }),
        META,
      );
      const r = d.resources[0];
      assert.strictEqual(r.mode, 'managed');
      assert.strictEqual(r.type, '');
      assert.strictEqual(r.name, '');
      assert.strictEqual(r.providerName, '');
      assert.strictEqual(d.summary.resourceCount, 1);
    });
  });

  describe('caps (§7.4)', () => {
    it('caps the resource list at MAX_STATE_RESOURCES in walk order and notes the count', () => {
      const resources = [];
      for (let i = 0; i < MAX_STATE_RESOURCES + 7; i++) {
        resources.push(resource({ address: `aws_x.n${String(i).padStart(5, '0')}`, name: `n${i}` }));
      }
      const d = buildStateDigest(state({ resources }), META);
      assert.strictEqual(d.resources.length, MAX_STATE_RESOURCES);
      // walk order preserved: the FIRST MAX_STATE_RESOURCES survive (no priority sort).
      assert.strictEqual(d.resources[0].address, 'aws_x.n00000');
      assert.strictEqual(d.resources[MAX_STATE_RESOURCES - 1].address, `aws_x.n${String(MAX_STATE_RESOURCES - 1).padStart(5, '0')}`);
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('state resource list capped')));
    });

    it('does not truncate exactly at the MAX_STATE_RESOURCES boundary', () => {
      const resources = [];
      for (let i = 0; i < MAX_STATE_RESOURCES; i++) {
        resources.push(resource({ address: `aws_x.n${String(i).padStart(5, '0')}`, name: `n${i}` }));
      }
      const d = buildStateDigest(state({ resources }), META);
      assert.strictEqual(d.resources.length, MAX_STATE_RESOURCES);
      assert.strictEqual(d.truncated, false);
      assert.strictEqual(d.truncationNotes, undefined);
    });

    it('caps attributes per resource alphabetically and notes the remainder', () => {
      const values: Record<string, unknown> = {};
      for (let i = 0; i < MAX_STATE_ATTRS_PER_RESOURCE + 13; i++) {
        values[`a${String(i).padStart(4, '0')}`] = i;
      }
      const d = buildStateDigest(state({ resources: [resource({ address: 'aws_big.b', values })] }), META);
      assert.strictEqual(d.resources[0].attributes.length, MAX_STATE_ATTRS_PER_RESOURCE);
      assert.strictEqual(d.resources[0].attributes[0].name, 'a0000');
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('attributes for aws_big.b capped')));
    });

    it('caps the output list and notes the remainder', () => {
      const outputs: Record<string, unknown> = {};
      for (let i = 0; i < MAX_OUTPUTS + 9; i++) {
        outputs[`o${String(i).padStart(5, '0')}`] = { value: `v${i}`, type: 'string', sensitive: false };
      }
      const d = buildStateDigest(state({ resources: [] }, outputs), META);
      assert.strictEqual(d.outputs.length, MAX_OUTPUTS);
      assert.strictEqual(d.truncated, true);
      assert.ok((d.truncationNotes ?? []).some((n) => n.includes('output list capped')));
    });
  });

  describe('envelope / provenance', () => {
    it('derives tool.version from terraform_version and echoes validated meta', () => {
      const d = buildStateDigest({ terraform_version: '1.10.3', values: { root_module: { resources: [] } } }, META);
      assert.deepStrictEqual(d.tool, { name: 'terraform', version: '1.10.3' });
      assert.strictEqual(d.meta.name, 'terraform-state');
      assert.strictEqual(d.meta.workingDirectory, 'infra');
      assert.strictEqual(d.producedBy.taskVersion, '0.0.0-test');
    });

    it('falls back to tool version "unknown" when terraform_version is missing', () => {
      const d = buildStateDigest(state({ resources: [] }), { ...META });
      assert.strictEqual(d.tool.version, '1.9.5');
      const d2 = buildStateDigest({ values: { root_module: { resources: [] } } }, META);
      assert.strictEqual(d2.tool.version, 'unknown');
    });

    it('echoes optional stage/job meta when provided', () => {
      const d = buildStateDigest(state({ resources: [] }), { ...META, stage: 'Deploy', job: 'state_job' });
      assert.strictEqual(d.meta.stage, 'Deploy');
      assert.strictEqual(d.meta.job, 'state_job');
    });
  });

  it('is deterministic: building twice yields byte-identical output', () => {
    const input = state(
      {
        resources: [
          resource({ address: 'aws_db_instance.main', values: { z: 1, a: 2, m: { q: 'x', b: 'y' } }, sensitive_values: { m: { q: true } } }),
        ],
        child_modules: [
          { address: 'module.n', resources: [resource({ address: 'module.n.aws_x.y' })] },
        ],
      },
      { out_b: { value: 'b', type: 'string', sensitive: false }, out_a: { value: 'a', type: 'string', sensitive: false } },
    );
    assert.strictEqual(serializeDigest(buildStateDigest(input, META)), serializeDigest(buildStateDigest(input, META)));
  });
});
