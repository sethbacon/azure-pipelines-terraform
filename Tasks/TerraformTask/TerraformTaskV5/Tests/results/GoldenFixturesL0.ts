import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES, FIXTURES_DIR, serializeFixture } from './golden-fixtures';

// REGRESSION FOUNDATION (§12.3) + NO-LEAK TRIPWIRE (§12.4.1).
//
// Each fixture is a SANITIZED capture (synthetic — it contains only FAKE
// secret-looking literals, never a real secret) under Tests/fixtures/. For each:
//   * the builder output is asserted BYTE-FOR-BYTE against a committed
//     `.expected.json` golden — a redaction/digest change that alters output
//     fails loudly and the diff shows exactly what changed; and
//   * every known-secret literal embedded in the INPUT is asserted to appear
//     NOWHERE in the serialized digest (the generic catch-all that trips even
//     for a value shape no targeted test covers).
//
// The digest builders are deterministic (redact.ts §2.6), so these goldens are
// byte-stable.

describe('golden fixtures (§12.3 regression) + no-leak tripwire (§12.4.1)', () => {
  for (const spec of FIXTURES) {
    describe(spec.input, () => {
      it('reproduces the committed golden byte-for-byte', () => {
        // JSON.stringify always emits LF; normalize the committed golden's line
        // endings (a Windows checkout with core.autocrlf may deliver CRLF) and
        // its trailing newline so the comparison is content-exact on both OS legs.
        const expected = fs.readFileSync(path.join(FIXTURES_DIR, spec.expected), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
        assert.strictEqual(serializeFixture(spec), expected, `${spec.expected} drifted — review the redaction/digest change`);
      });

      it('leaks no known-secret literal into the serialized digest', () => {
        const digest = serializeFixture(spec);
        for (const secret of spec.secrets) {
          assert.ok(!digest.includes(secret), `SECURITY: secret literal "${secret}" leaked into ${spec.input} digest`);
        }
      });
    });
  }

  it('is deterministic: building twice yields byte-identical output', () => {
    for (const spec of FIXTURES) {
      assert.strictEqual(serializeFixture(spec), serializeFixture(spec), `${spec.input} is non-deterministic`);
    }
  });
});
