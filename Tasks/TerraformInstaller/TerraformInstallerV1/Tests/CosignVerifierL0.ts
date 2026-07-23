import { describe, it, afterEach } from 'mocha';
import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
import crypto = require('crypto');
import tasks = require('azure-pipelines-task-lib/task');
import { buildOpenTofuCertIdentityRegexp, verifyCosignSignature } from '../src/cosign-verifier';
import { isVerificationFailure } from '../src/verification-failure';
import * as httpClient from '../src/http-client';

// Direct (non-MockTestRunner) unit tests for the cosign verifier. These run in
// the mocha parent process and stub the shared task-lib / http-client singletons
// in place; the MockTestRunner integration tests in L0.ts run in child processes
// and are unaffected. afterEach restores every stub.

describe('cosign-verifier: OpenTofu certificate identity regexp (version-bound, #611; workflow-file-bound, #697)', () => {
    const VERSION = '1.11.6';
    const identityRe = new RegExp(buildOpenTofuCertIdentityRegexp(VERSION));

    // The canonical SANs OpenTofu's keyless release signing produces for THIS
    // version -- confirmed against the real upstream workflow file (opentofu/
    // opentofu's .github/workflows/release.yml). Both the (older/occasional)
    // full-version tag ref and the (current, 1.12.x-line) major.minor release
    // branch ref must be accepted -- confirmed directly against the real
    // Fulcio certificate for the current upstream release (tofu_1.12.4_
    // SHA256SUMS.pem's SAN is .../release.yml@refs/heads/v1.12).
    const accepted = [
        `https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v${VERSION}`,
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v1.11',
    ];

    // Each of these satisfied the previous any-version `@refs/tags/v[0-9].*` pattern
    // (or the earlier unanchored one) but must now be rejected for VERSION.
    const rejected = [
        // Cross-version identities — the replay gap #611 closes: a validly-signed
        // SHA256SUMS from a DIFFERENT OpenTofu release no longer satisfies the identity.
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.7',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.5',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v2.0.0',
        // The version's own dots are literal (regex-escaped), and the pattern is
        // anchored, so a longer numeric tail cannot slip past.
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.60',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1x11x6',
        // A DIFFERENT major.minor release branch must still be rejected (cross-
        // release-line replay via the branch alternative).
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v1.10',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v1.12',
        // The branch alternative only ever encodes major.minor -- a branch ref
        // carrying the full patch version is not a real OpenTofu ref and must
        // still be rejected.
        `https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v${VERSION}`,
        // #697: the workflow-file segment is now bound to the exact, real signing
        // workflow (release.yml) instead of a permissive `.+` -- a look-alike or
        // otherwise-named workflow file on the SAME repo and exact tag ref must
        // no longer satisfy the identity.
        `https://github.com/opentofu/opentofu/.github/workflows/release-official.yml@refs/tags/v${VERSION}`,
        `https://github.com/opentofu/opentofu/.github/workflows/other.yml@refs/tags/v${VERSION}`,
        // Original anchoring / look-alike protections still hold.
        'https://github.com/opentofu/opentofu',
        'https://github.com/opentofu/opentofu-malicious/.github/workflows/release.yml@refs/tags/v1.11.6',
        'https://github.com/evil/opentofu/.github/workflows/release.yml@refs/tags/v1.11.6',
        'https://evil.com/?u=https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.6',
        'xhttps://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.6',
        'http://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.6',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/main',
        'https://githubXcom/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.6',
    ];

    accepted.forEach((id) => {
        it(`accepts the requested version's identity ${id}`, () => {
            assert.ok(identityRe.test(id), `expected the regexp to accept ${id}`);
        });
    });

    rejected.forEach((id) => {
        it(`rejects the non-matching identity ${id}`, () => {
            assert.ok(!identityRe.test(id), `expected the regexp to reject ${id}`);
        });
    });

    it('regex-escapes a prerelease version so its metacharacters match literally', () => {
        const re = new RegExp(buildOpenTofuCertIdentityRegexp('1.7.0-alpha1'));
        assert.ok(
            re.test('https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.7.0-alpha1'),
            'should accept the exact prerelease tag',
        );
        assert.ok(
            !re.test('https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.7.0-alpha2'),
            'should reject a different prerelease tag',
        );
        // A prerelease version still carries a real major.minor, so its own
        // release-branch ref must also be accepted.
        assert.ok(
            re.test('https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v1.7'),
            'should accept the prerelease version\'s own major.minor branch ref',
        );
    });

    it('falls back to a tag-only pattern for a version with no leading major.minor', () => {
        const re = new RegExp(buildOpenTofuCertIdentityRegexp('unusual-version'));
        assert.ok(
            re.test('https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/vunusual-version'),
            'should still accept the exact tag ref for the literal version string',
        );
        assert.ok(
            !re.test('https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/vunusual-version'),
            'should not accept a branch ref when no major.minor could be extracted',
        );
    });
});

describe('cosign-verifier: verifyCosignSignature behavior', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const t = tasks as any;
    const hc = httpClient as any;
    const original = {
        which: t.which, warning: t.warning, debug: t.debug, tool: t.tool,
        fetchBufferAllow404: hc.fetchBufferAllow404,
    };
    let warnings: string[] = [];
    const VERSION = '1.11.6';

    afterEach(() => {
        t.which = original.which;
        t.warning = original.warning;
        t.debug = original.debug;
        t.tool = original.tool;
        hc.fetchBufferAllow404 = original.fetchBufferAllow404;
        warnings = [];
    });

    function stubLogging(): void {
        t.warning = (m: string) => { warnings.push(m); };
        t.debug = (_m: string) => { /* silence */ };
    }

    it('throws when cosign is missing and verification is required', async () => {
        stubLogging();
        t.which = () => { throw new Error('cosign not found'); };
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true),
            /cosign is required/,
        );
    });

    it('warns and returns when cosign is missing and verification is not required', async () => {
        stubLogging();
        t.which = () => { throw new Error('cosign not found'); };
        await verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, false);
        assert.ok(
            warnings.some((w) => /without signature verification/.test(w)),
            'expected a downgrade warning',
        );
    });

    it('throws a typed VerificationFailure when signature/certificate are withheld and required (#589)', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => null;
        // Reachable release withholding required signing material must fail closed as a
        // VerificationFailure (so the cache-hit re-verify path re-throws), not degrade.
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true),
            (err: unknown) => {
                assert.ok(isVerificationFailure(err), 'expected a VerificationFailure');
                assert.match((err as Error).message, /unavailable and verification is required/);
                return true;
            },
        );
    });

    it('passes the version-bound identity regexp and pinned OIDC issuer to cosign', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => new Uint8Array([1, 2, 3]);
        const args: string[] = [];
        t.tool = (_path: string) => ({
            arg(a: string | string[]) {
                if (Array.isArray(a)) { args.push(...a); } else { args.push(a); }
                return this;
            },
            exec: async () => 0,
        });

        await verifyCosignSignature('sums-content', 'https://x.example/sig', 'https://x.example/pem', VERSION, true);

        const idIdx = args.indexOf('--certificate-identity-regexp');
        assert.ok(idIdx >= 0, 'the --certificate-identity-regexp flag should be passed');
        assert.strictEqual(args[idIdx + 1], buildOpenTofuCertIdentityRegexp(VERSION));
        // The passed regexp must bind the exact version (with escaped dots) on the
        // tag alternative, not any tag.
        assert.ok(args[idIdx + 1].includes('tags/v1\\.11\\.6'), 'the identity regexp must anchor the exact requested version on the tag alternative');
        // ...and must bind only VERSION's own major.minor on the branch alternative.
        assert.ok(args[idIdx + 1].includes('heads/v1\\.11)$'), 'the identity regexp must anchor the requested version\'s major.minor on the branch alternative');
        const issIdx = args.indexOf('--certificate-oidc-issuer');
        assert.ok(issIdx >= 0, 'the --certificate-oidc-issuer flag should be passed');
        assert.strictEqual(args[issIdx + 1], 'https://token.actions.githubusercontent.com');
    });

    it('logs the resolved cosign path so a shadowed binary is auditable', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => new Uint8Array([1]);
        t.tool = (_path: string) => ({
            arg() { return this; },
            exec: async () => 0,
        });
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: unknown) => { logs.push(String(m)); };
        try {
            await verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true);
        } finally {
            console.log = origLog;
        }
        assert.ok(
            logs.some((l) => l.includes('/usr/bin/cosign')),
            'expected the resolved cosign path to be logged',
        );
    });

    it('throws a VerificationFailure when cosign exits non-zero', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => new Uint8Array([1]);
        t.tool = (_path: string) => ({
            arg() { return this; },
            exec: async () => 1,
        });
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true),
            (err: unknown) => {
                assert.ok(isVerificationFailure(err), 'a cosign verification failure must be typed');
                assert.match((err as Error).message, /verification failed/i);
                return true;
            },
        );
    });

    it('treats a non-404 signature/certificate fetch failure as fatal even when not required', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => { throw new Error('HTTP 503'); };
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, false),
            /fetch failed for OpenTofu verification/,
        );
    });

    // #550: an operator-pinned cosignSha256 verifies the RESOLVED binary itself,
    // closing the ambient-PATH trust gap (a PATH-write attacker could otherwise
    // shadow `cosign` with an always-succeeding stub).
    describe('cosignSha256 pin (#550)', () => {
        let tmpDirToClean: string;

        afterEach(() => {
            if (tmpDirToClean) {
                try { fs.rmSync(tmpDirToClean, { recursive: true, force: true }); } catch { /* already removed */ }
            }
        });

        it('succeeds when the resolved cosign binary matches the pinned SHA256', async () => {
            stubLogging();
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosign-pin-test-'));
            tmpDirToClean = tmpDir;
            const tmpCosignPath = path.join(tmpDir, 'cosign-fake-binary');
            const content = Buffer.from('fake cosign binary content for a hash test');
            fs.writeFileSync(tmpCosignPath, content);
            const expectedHash = crypto.createHash('sha256').update(content).digest('hex');

            t.which = () => tmpCosignPath;
            hc.fetchBufferAllow404 = async () => new Uint8Array([1]);
            t.tool = (_path: string) => ({
                arg() { return this; },
                exec: async () => 0,
            });

            await verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true, expectedHash);
        });

        it('throws a VerificationFailure when the resolved cosign binary does not match the pinned SHA256', async () => {
            stubLogging();
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosign-pin-test-'));
            tmpDirToClean = tmpDir;
            const tmpCosignPath = path.join(tmpDir, 'cosign-fake-binary');
            fs.writeFileSync(tmpCosignPath, Buffer.from('the real, expected cosign binary content'));

            t.which = () => tmpCosignPath;
            hc.fetchBufferAllow404 = async () => new Uint8Array([1]);
            t.tool = (_path: string) => ({
                arg() { return this; },
                exec: async () => 0,
            });

            const wrongHash = 'a'.repeat(64);
            await assert.rejects(
                verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true, wrongHash),
                (err: unknown) => {
                    assert.ok(isVerificationFailure(err), 'a cosign hash mismatch must be a typed VerificationFailure (fail closed)');
                    assert.match((err as Error).message, /does not match the pinned cosignSha256/);
                    return true;
                },
            );
        });

        it('does not compute or check any hash when cosignSha256 is left unset (default, unchanged behavior)', async () => {
            stubLogging();
            t.which = () => '/usr/bin/cosign'; // a path that does not exist -- proves no fs read is attempted
            hc.fetchBufferAllow404 = async () => new Uint8Array([1]);
            t.tool = (_path: string) => ({
                arg() { return this; },
                exec: async () => 0,
            });

            await verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', VERSION, true);
        });
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

// Real cosign invocation (#656). Every test above stubs tasks.tool()/exec() and only
// inspects the argv, so the actual cosign binary is never spawned. This block runs
// the REAL cosign binary end-to-end through verifyCosignSignature (real tasks.which,
// real ToolRunner, real process) when cosign is present on PATH, and SKIPS with a
// message otherwise — so it degrades gracefully in the per-PR Installer V1 CI job,
// which installs no cosign. It feeds cosign a syntactically-real but non-matching
// certificate/signature so the real binary actually parses our exact argv and returns
// a verification failure offline (a malformed certificate fails before any Sigstore/
// Rekor network call), proving the argv construction + ToolRunner wiring + non-zero-
// exit → VerificationFailure mapping hold against a real cosign. The POSITIVE
// end-to-end verify against genuine OpenTofu keyless material (which needs Sigstore
// network + a real release) is covered by weekly-security.yml's opentofu-cosign-canary,
// which installs cosign and drives this same verifyCosignSignature code.
describe('cosign-verifier: real cosign invocation (defined only when cosign is available) (#656)', function () {
    this.timeout(30000);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const hc = httpClient as any;
    const origFetchBufferAllow404 = hc.fetchBufferAllow404;
    const VERSION = '1.11.6';

    // Detect cosign synchronously at test-tree-build time so the real-binary test is
    // DEFINED only when cosign is present, rather than defined-then-this.skip()'d at
    // run time. A runtime this.skip() marks the test PENDING, which the suite's
    // --forbid-pending flag (#784) treats as a failure; conditionally defining it
    // instead degrades gracefully in the per-PR Installer V1 CI job (which installs
    // no cosign) with no pending test.
    let cosignAvailable = false;
    try {
        tasks.which('cosign', true);
        cosignAvailable = true;
    } catch {
        console.log('cosign not found on PATH — the real cosign invocation test is not defined (#656).');
    }

    afterEach(() => { hc.fetchBufferAllow404 = origFetchBufferAllow404; });

    if (cosignAvailable) {
        it('spawns the real cosign binary with the built argv and maps its failure to a VerificationFailure', async function () {
            // A well-formed PEM wrapper around non-certificate bytes: cosign parses the
            // --certificate flag we pass, fails to load it as a real X.509 cert, and exits
            // non-zero — offline, deterministically, without contacting Rekor.
            hc.fetchBufferAllow404 = async (url: string) =>
                url.endsWith('.pem')
                    ? new TextEncoder().encode('-----BEGIN CERTIFICATE-----\nbm90LWEtcmVhbC1jZXJ0\n-----END CERTIFICATE-----\n')
                    : new Uint8Array([0x00, 0x01, 0x02, 0x03]);
            await assert.rejects(
                verifyCosignSignature('sums-content', 'https://x.example/SHA256SUMS.sig', 'https://x.example/SHA256SUMS.pem', VERSION, true),
                (err: unknown) => {
                    assert.ok(isVerificationFailure(err), 'a real cosign non-zero exit must map to a typed VerificationFailure');
                    return true;
                },
            );
        });
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
});
