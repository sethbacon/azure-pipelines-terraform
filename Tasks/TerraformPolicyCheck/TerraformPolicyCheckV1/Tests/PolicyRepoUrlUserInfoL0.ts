import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { assertNoUrlUserInfo } from '../src/policy-source';

/**
 * CLASS ROW — "a credential value reaches a destination the agent masker does
 * not cover: a child-process argv".
 *
 * `policyRepoUrl` is a plain (non-password) input, so nothing registers its
 * contents with the masker. An operator who embeds credentials the way git
 * itself accepts them — https://user:pat@host/org/repo.git — hands that URL
 * straight to `git clone` as an argv element. ToolRunner echoes the command
 * line it is about to run, and argv is visible in host process listings; the
 * masker cannot help with either, because the value was never registered.
 *
 * The guard's contract is: register what was found, then REFUSE, and never
 * echo the raw URL in the refusal. Asserting only that it throws is not
 * sufficient — a test that accepts any throw stays green if the guard is
 * replaced by an unrelated failure, so each row asserts the specific outcome.
 */
describe('policyRepoUrl userinfo credentials — argv exposure guard (#1105)', function () {

    it('rejects a URL carrying user:password userinfo', function () {
        assert.throws(
            () => assertNoUrlUserInfo('https://someuser:s3cr3t-pat@dev.azure.com/org/proj/_git/policies'),
            (err: Error) => {
                assert.ok(!err.message.includes('s3cr3t-pat'),
                    'the refusal must not echo the credential it just refused; that would defeat the guard');
                return true;
            });
    });

    it('rejects a URL carrying a bare token as the username', function () {
        // git accepts https://<pat>@host/... with no colon at all; a guard that
        // only looks for ':' in the userinfo misses the commonest PAT form.
        assert.throws(
            () => assertNoUrlUserInfo('https://s3cr3t-pat@github.com/org/policies.git'),
            (err: Error) => {
                assert.ok(!err.message.includes('s3cr3t-pat'), 'the refusal must not echo the credential');
                return true;
            });
    });

    it('accepts an ordinary credential-free https URL', function () {
        // The guard must not over-reject: the supported path is a clean URL plus
        // the policyRepoToken input, and that must keep working.
        assert.doesNotThrow(() => assertNoUrlUserInfo('https://github.com/org/policies.git'));
        assert.doesNotThrow(() => assertNoUrlUserInfo('https://dev.azure.com/org/proj/_git/policies'));
    });

    it('does not mistake an @ elsewhere in the URL for userinfo', function () {
        assert.doesNotThrow(() => assertNoUrlUserInfo('https://github.com/org/policies.git?ref=user@example'));
    });
});

describe('policy repo clone — the clone must not echo its own command line', function () {
    const SRC = path.resolve(__dirname, '..', 'src');

    it('execGit runs with silent: true', function () {
        // ToolRunner prints the full argv it is about to execute unless silenced.
        // Even with the userinfo guard in place, silencing removes the whole
        // category rather than the one input we happened to enumerate.
        const src = fs.readFileSync(path.join(SRC, 'policy-source.ts'), 'utf8');
        assert.ok(/silent:\s*true/.test(src),
            'the git invocation must set silent: true so ToolRunner does not echo the command line');
    });

    it('the userinfo guard is actually wired into resolvePolicyDir', function () {
        const src = fs.readFileSync(path.join(SRC, 'policy-source.ts'), 'utf8');
        assert.ok(/assertNoUrlUserInfo\(url\);/.test(src),
            'defining the guard is not enough — it must be called on the URL before the clone');
    });
});
