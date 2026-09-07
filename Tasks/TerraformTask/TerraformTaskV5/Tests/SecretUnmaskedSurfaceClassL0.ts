import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractVarFileScalarStrings } from '../src/secure-var-file-masking';
import { scrubSecrets } from '../src/results/secret-scrub';

/**
 * CLASS TEST — "a credential value never reaches the agent's masker, or reaches
 * a surface the masker does not cover".
 *
 * The masker is not the control; REACHING the masker is the control. Each row
 * below is a distinct mechanism by which a value that should have been masked
 * was not, or was published somewhere masking does not apply.
 *
 *   S1  extractor drops the value  — a quoted value containing ` #` or ` //` was
 *                                    truncated by a comment-stripping pre-pass
 *                                    with no string awareness
 *   S2  extractor mis-pairs quotes — the truncation left an unterminated quote,
 *                                    so the global regex paired it with a quote
 *                                    on a LATER line and registered an unrelated
 *                                    fragment as if it were the secret
 *   S3  whole shape unsupported    — a heredoc body (the idiomatic way to put a
 *                                    PEM key in a var file) contains no quoted
 *                                    literal, so it was never extracted at all
 *   S4  unmasked surface           — a pipeline attachment is not agent-masked,
 *                                    and the legacy plan-results attachment
 *                                    published raw plan stdout with no scrub
 *
 * Every row must fail if its own guard is mutated (gate 1d). Asserting merely
 * that extraction "returns something" is never sufficient — each row asserts the
 * specific value that the pre-fix code got WRONG.
 */
describe('Batch B class — secret-reaches-unmasked-surface', () => {

    describe('S1/S2 — comment stripping must be string-aware', () => {
        it('extracts a quoted value containing a # (pre-fix: truncated at the #)', () => {
            const values = extractVarFileScalarStrings('password = "abc #def"\n');
            assert.deepStrictEqual(values, ['abc #def'],
                'the whole quoted value must be extracted; a comment pre-pass truncated it to "abc " and the real secret was never registered');
        });

        it('extracts a quoted value containing a // (pre-fix: truncated at the //)', () => {
            const values = extractVarFileScalarStrings('endpoint = "https://user@example.com/path"\n');
            assert.deepStrictEqual(values, ['https://user@example.com/path'],
                'a URL-bearing value must survive intact; the // was treated as a comment start');
        });

        it('does NOT pair an unterminated quote with a quote on a later line', () => {
            // Pre-fix: stripLineComments turned line 1 into `password = "abc ` and
            // the global regex then matched from that dangling quote all the way to
            // the opening quote of `other`, registering `abc \nother = ` as a secret
            // while the real password went unmasked.
            const values = extractVarFileScalarStrings('password = "abc #def"\nother = "harmless"\n');
            assert.deepStrictEqual(values, ['abc #def', 'harmless'],
                'each line must yield its own value; a stray quote must not pair across lines');
            for (const v of values) {
                assert.ok(!v.includes('\n'),
                    `a quoted scalar must never span lines, got ${JSON.stringify(v)} — that is the cross-line mis-pairing`);
            }
        });

        it('still ignores a genuinely commented-out quoted value', () => {
            // The guard must not over-correct: a quoted word inside a real comment
            // is not a value, and registering it would blank unrelated log text.
            assert.deepStrictEqual(extractVarFileScalarStrings('# note = "notasecret"\n'), []);
            assert.deepStrictEqual(extractVarFileScalarStrings('// note = "notasecret"\n'), []);
        });

        it('ignores a trailing comment while keeping the value before it', () => {
            const values = extractVarFileScalarStrings('token = "s3cret-value" # this is the token\n');
            assert.deepStrictEqual(values, ['s3cret-value']);
        });
    });

    describe('S3 — heredoc bodies must be extracted', () => {
        it('extracts a <<EOT heredoc body (pre-fix: returned nothing at all)', () => {
            const content = [
                'private_key = <<EOT',
                '-----BEGIN RSA PRIVATE KEY-----',
                'MIIEowIBAAKCAQEAxLongBase64Payload',
                '-----END RSA PRIVATE KEY-----',
                'EOT',
                '',
            ].join('\n');
            const values = extractVarFileScalarStrings(content);
            assert.strictEqual(values.length, 1, 'the heredoc body must be extracted as one value');
            assert.ok(values[0].includes('MIIEowIBAAKCAQEAxLongBase64Payload'),
                'the heredoc body must contain the credential payload; pre-fix no heredoc body was ever extracted');
            assert.ok(!values[0].includes('EOT'), 'the terminator must not be part of the body');
        });

        it('extracts an indented <<-EOT heredoc and accepts an indented terminator', () => {
            const content = [
                'key = <<-EOT',
                '    line-one-of-the-secret',
                '    line-two-of-the-secret',
                '    EOT',
                '',
            ].join('\n');
            const values = extractVarFileScalarStrings(content);
            assert.strictEqual(values.length, 1);
            assert.ok(values[0].includes('line-one-of-the-secret'));
            assert.ok(values[0].includes('line-two-of-the-secret'));
        });

        it('extracts a heredoc whose body contains a double quote', () => {
            // A quote inside a heredoc body must not be treated as opening an HCL
            // string literal — the body is opaque text.
            const content = ['cert = <<EOT', 'value-with-a-"-inside', 'EOT', ''].join('\n');
            const values = extractVarFileScalarStrings(content);
            assert.strictEqual(values.length, 1);
            assert.strictEqual(values[0], 'value-with-a-"-inside');
        });

        it('extracts a heredoc that is never terminated, up to end-of-file', () => {
            // Malformed file, but the bytes are still a credential the tool may
            // echo; refusing to mask them is the worse failure.
            const content = ['key = <<EOT', 'unterminated-secret-body', ''].join('\n');
            const values = extractVarFileScalarStrings(content);
            assert.strictEqual(values.length, 1);
            assert.ok(values[0].includes('unterminated-secret-body'));
        });

        it('extracts both a heredoc and ordinary quoted values from the same file', () => {
            const content = [
                'name = "plain-value-here"',
                'key = <<EOT',
                'heredoc-secret-body',
                'EOT',
                'other = "second-plain-value"',
                '',
            ].join('\n');
            const values = extractVarFileScalarStrings(content);
            assert.deepStrictEqual(values, ['plain-value-here', 'heredoc-secret-body', 'second-plain-value']);
        });
    });

    describe('JSON var files keep working', () => {
        it('extracts nested string values from a .tfvars.json', () => {
            const values = extractVarFileScalarStrings('{"a":"first-value","b":{"c":["second-value"]}}');
            assert.deepStrictEqual(values.sort(), ['first-value', 'second-value']);
        });
    });

    describe('S4 — the legacy plan-results attachment must be scrubbed', () => {
        // An attachment file is NOT agent-masked: the same text echoed to the
        // console is redacted for every registered secret, but the uploaded file
        // is not, and it is readable by anyone with build-read.
        it('removes a tracked secret value from plan text', () => {
            const secret = 'AKIAIOSFODNN7EXAMPLEKEY';
            const planText = `  + access_key = "${secret}"\n  + name = "bucket"\n`;
            const scrubbed = scrubSecrets(planText, [secret]);
            assert.ok(!scrubbed.includes(secret),
                'a value registered with the masker must not survive into the attachment file');
            assert.ok(scrubbed.includes('bucket'), 'non-secret plan text must be preserved');
        });

        it('is a no-op for plan text containing no secrets', () => {
            const planText = '  + name = "bucket"\n';
            assert.strictEqual(scrubSecrets(planText, []), planText);
        });
    });

    describe('the guard is wired into the shipping call sites', () => {
        const SRC = path.resolve(__dirname, '..', 'src');

        it('base-terraform-command-handler scrubs before writing the plan attachment', () => {
            const src = fs.readFileSync(path.join(SRC, 'base-terraform-command-handler.ts'), 'utf8');
            assert.ok(/writeSecretFile\(attachmentPath,\s*scrubSecrets\(/.test(src),
                'the legacy terraform-plan-results attachment must be written through scrubSecrets, not raw planStdout');
            assert.ok(!/writeSecretFile\(attachmentPath,\s*planStdout\)/.test(src),
                'the pre-fix raw write must be gone');
        });

        it('the var-file masker warns (not debugs) when it extracts nothing', () => {
            const src = fs.readFileSync(path.join(SRC, 'secure-var-file-masking.ts'), 'utf8');
            assert.ok(/values\.length === 0[\s\S]{0,600}tasks\.warning\(/.test(src),
                'zero extracted values is the observable signature of extractor failure and must warn, since a control that silently masks nothing is the finding itself');
        });

        it('the comment-stripping regex pre-pass is gone', () => {
            const src = fs.readFileSync(path.join(SRC, 'secure-var-file-masking.ts'), 'utf8');
            assert.ok(!src.includes('function stripLineComments'),
                'the string-unaware comment pre-pass must be replaced by a stateful scan');
        });
    });
});

/**
 * Cross-repo row. packer-ext carries its own copy of secure-var-file-masking.ts
 * with the identical defect; it is a separate npm package that cannot be
 * imported from here, so it is asserted at source level against the same
 * predicate. This is the row that would have caught the duplication drifting.
 */
describe('Batch B class — packer-ext sibling copy', () => {
    const PACKER_SRC = path.resolve(
        __dirname, '..', '..', '..', '..', '..',
        'packer-ext', 'Tasks', 'PackerTask', 'PackerTaskV1', 'src', 'secure-var-file-masking.ts');

    it('carries the same string-aware scan and heredoc support', () => {
        if (!fs.existsSync(PACKER_SRC)) {
            // The sibling repo is only checked out alongside this one in the batch
            // worktree layout; in CI for this repo alone the row is inert. The
            // durable cross-repo guarantee is the parity gate entry, not this row.
            return;
        }
        const src = fs.readFileSync(PACKER_SRC, 'utf8');
        assert.ok(!src.includes('function stripLineComments'),
            'packer-ext must not retain the string-unaware comment pre-pass');
        assert.ok(src.includes('HEREDOC_OPEN'),
            'packer-ext must extract heredoc bodies, same as terraform-ext');
    });
});
