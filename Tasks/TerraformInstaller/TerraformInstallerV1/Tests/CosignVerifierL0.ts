import { describe, it, afterEach } from 'mocha';
import assert = require('assert');
import tasks = require('azure-pipelines-task-lib/task');
import { OPENTOFU_CERT_IDENTITY_REGEXP, verifyCosignSignature } from '../src/cosign-verifier';
import * as httpClient from '../src/http-client';

// Direct (non-MockTestRunner) unit tests for the cosign verifier. These run in
// the mocha parent process and stub the shared task-lib / http-client singletons
// in place; the MockTestRunner integration tests in L0.ts run in child processes
// and are unaffected. afterEach restores every stub.

const identityRe = new RegExp(OPENTOFU_CERT_IDENTITY_REGEXP);

describe('cosign-verifier: OpenTofu certificate identity regexp', () => {
    // The canonical SAN OpenTofu's keyless release signing produces.
    const accepted = [
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.11.6',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.6.0',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.7.0-alpha1',
    ];

    // Each of these satisfied the previous unanchored `https://github.com/opentofu/opentofu`
    // pattern (or could, via substring / dot-wildcard) but is a different identity.
    const rejected = [
        'https://github.com/opentofu/opentofu',
        'https://github.com/opentofu/opentofu-malicious/.github/workflows/release.yml@refs/tags/v1.0.0',
        'https://github.com/evil/opentofu/.github/workflows/release.yml@refs/tags/v1.0.0',
        'https://evil.com/?u=https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.0.0',
        'xhttps://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.0.0',
        'http://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.0.0',
        'https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/main',
        'https://githubXcom/opentofu/opentofu/.github/workflows/release.yml@refs/tags/v1.0.0',
    ];

    accepted.forEach((id) => {
        it(`accepts the canonical identity ${id}`, () => {
            assert.ok(identityRe.test(id), `expected the regexp to accept ${id}`);
        });
    });

    rejected.forEach((id) => {
        it(`rejects the look-alike identity ${id}`, () => {
            assert.ok(!identityRe.test(id), `expected the regexp to reject ${id}`);
        });
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
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', true),
            /cosign is required/,
        );
    });

    it('warns and returns when cosign is missing and verification is not required', async () => {
        stubLogging();
        t.which = () => { throw new Error('cosign not found'); };
        await verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', false);
        assert.ok(
            warnings.some((w) => /without signature verification/.test(w)),
            'expected a downgrade warning',
        );
    });

    it('throws when signature/certificate are unavailable and verification is required', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => null;
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', true),
            /unavailable and verification is required/,
        );
    });

    it('passes the anchored identity regexp and pinned OIDC issuer to cosign', async () => {
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

        await verifyCosignSignature('sums-content', 'https://x.example/sig', 'https://x.example/pem', true);

        const idIdx = args.indexOf('--certificate-identity-regexp');
        assert.ok(idIdx >= 0, 'the --certificate-identity-regexp flag should be passed');
        assert.strictEqual(args[idIdx + 1], OPENTOFU_CERT_IDENTITY_REGEXP);
        const issIdx = args.indexOf('--certificate-oidc-issuer');
        assert.ok(issIdx >= 0, 'the --certificate-oidc-issuer flag should be passed');
        assert.strictEqual(args[issIdx + 1], 'https://token.actions.githubusercontent.com');
    });

    it('throws when cosign exits non-zero', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => new Uint8Array([1]);
        t.tool = (_path: string) => ({
            arg() { return this; },
            exec: async () => 1,
        });
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', true),
            /verification failed/i,
        );
    });

    it('treats a non-404 signature/certificate fetch failure as fatal even when not required', async () => {
        stubLogging();
        t.which = () => '/usr/bin/cosign';
        hc.fetchBufferAllow404 = async () => { throw new Error('HTTP 503'); };
        await assert.rejects(
            verifyCosignSignature('sums', 'https://x.example/sig', 'https://x.example/pem', false),
            /fetch failed for OpenTofu verification/,
        );
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
});
