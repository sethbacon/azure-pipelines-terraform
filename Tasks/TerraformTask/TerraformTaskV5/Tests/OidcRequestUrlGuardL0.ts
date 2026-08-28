import * as assert from 'assert';
import { resolveOidcRequestUrl } from '../src/credential-guards';

/**
 * Direct unit tests for the OIDC request-endpoint guard (#1026 follow-up).
 *
 * `resolveOidcRequestUrl` decides where the azurerm provider is allowed to send
 * the job's access token when it refreshes its own federated token, so the host
 * allowlist is the security boundary -- the same one
 * `pipeline-task-ado`'s id-token-generator applies to its own request, mirrored
 * here as a parallel implementation (see credential-guards.ts's header).
 *
 * The behavioural half lives in CredentialFailClosedMatrixL0 (the value is
 * actually pinned as ARM_OIDC_REQUEST_URL and survives the ambient clear); these
 * rows pin the grammar itself, including the branches a full-handler run cannot
 * reach cheaply.
 */
describe('resolveOidcRequestUrl — Azure DevOps OIDC endpoint allowlist (#1026)', function () {
    const SAVED = {
        uri: process.env['SYSTEM_OIDCREQUESTURI'],
        collection: process.env['SYSTEM_COLLECTIONURI'],
        tfsCollection: process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'],
    };

    function setEnv(uri?: string, collection?: string, tfsCollection?: string): void {
        if (uri === undefined) delete process.env['SYSTEM_OIDCREQUESTURI'];
        else process.env['SYSTEM_OIDCREQUESTURI'] = uri;
        if (collection === undefined) delete process.env['SYSTEM_COLLECTIONURI'];
        else process.env['SYSTEM_COLLECTIONURI'] = collection;
        if (tfsCollection === undefined) delete process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'];
        else process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'] = tfsCollection;
    }

    afterEach(() => {
        setEnv(SAVED.uri, SAVED.collection, SAVED.tfsCollection);
    });

    // --- absent: degrade, never fabricate ------------------------------------

    it('returns undefined when the agent published no SYSTEM_OIDCREQUESTURI', () => {
        setEnv(undefined);
        assert.strictEqual(resolveOidcRequestUrl(), undefined);
    });

    it('returns undefined for an empty SYSTEM_OIDCREQUESTURI rather than an empty endpoint', () => {
        setEnv('');
        assert.strictEqual(resolveOidcRequestUrl(), undefined);
    });

    // --- accepted hosts ------------------------------------------------------

    for (const accepted of [
        'https://vstoken.dev.azure.com/oidc',
        'https://dev.azure.com/_apis/oidctoken',
        'https://myorg.vssps.dev.azure.com/oidc',
    ]) {
        it(`accepts a genuine Azure DevOps endpoint: ${accepted}`, () => {
            setEnv(accepted);
            assert.strictEqual(resolveOidcRequestUrl(), accepted);
        });
    }

    // --- rejected: scheme and shape -----------------------------------------

    it('rejects a non-https endpoint, which would put the job token on the wire in cleartext', () => {
        setEnv('http://vstoken.dev.azure.com/oidc');
        assert.throws(() => resolveOidcRequestUrl(), /must be an https:\/\/ URL/);
    });

    it('rejects an unparseable endpoint instead of passing it through', () => {
        setEnv('not-a-url');
        assert.throws(() => resolveOidcRequestUrl(), /not a valid URL/);
    });

    // --- rejected: untrusted hosts ------------------------------------------

    for (const rejected of [
        'https://evil.example.com/oidc',
        // Suffix look-alikes: the allowlist must match on a real label boundary.
        'https://notdev.azure.com/oidc',
        'https://dev.azure.com.evil.example.com/oidc',
    ]) {
        it(`rejects an untrusted host rather than forwarding the token to it: ${rejected}`, () => {
            setEnv(rejected);
            assert.throws(() => resolveOidcRequestUrl(), /not a recognized Azure DevOps OIDC endpoint/);
        });
    }

    // --- *.visualstudio.com: trusted only for the job's OWN org --------------

    it("accepts a legacy *.visualstudio.com endpoint for the job's own org", () => {
        setEnv('https://myorg.visualstudio.com/oidc', 'https://myorg.visualstudio.com/');
        assert.strictEqual(resolveOidcRequestUrl(), 'https://myorg.visualstudio.com/oidc');
    });

    it('rejects a *.visualstudio.com endpoint belonging to a DIFFERENT org', () => {
        setEnv('https://attacker.visualstudio.com/oidc', 'https://myorg.visualstudio.com/');
        assert.throws(() => resolveOidcRequestUrl(), /not a recognized Azure DevOps OIDC endpoint/);
    });

    it('rejects a *.visualstudio.com endpoint when the collection URI is the dev.azure.com form (no comparable org label)', () => {
        setEnv('https://attacker.visualstudio.com/oidc', 'https://dev.azure.com/myorg/');
        assert.throws(() => resolveOidcRequestUrl(), /not a recognized Azure DevOps OIDC endpoint/);
    });

    it('rejects a *.visualstudio.com endpoint when no collection URI is published at all', () => {
        setEnv('https://attacker.visualstudio.com/oidc');
        assert.throws(() => resolveOidcRequestUrl(), /not a recognized Azure DevOps OIDC endpoint/);
    });

    it('falls back to the legacy collection variable for the org comparison', () => {
        setEnv('https://myorg.visualstudio.com/oidc', undefined, 'https://myorg.visualstudio.com/');
        assert.strictEqual(resolveOidcRequestUrl(), 'https://myorg.visualstudio.com/oidc');
    });

    it('treats an unparseable collection URI as vouching for nothing', () => {
        setEnv('https://myorg.visualstudio.com/oidc', 'not-a-url');
        assert.throws(() => resolveOidcRequestUrl(), /not a recognized Azure DevOps OIDC endpoint/);
    });

    // --- on-prem: the collection host itself ---------------------------------

    it('accepts an on-prem Azure DevOps Server host that matches the job collection host', () => {
        setEnv('https://tfs.corp.example/tfs/oidc', 'https://tfs.corp.example/tfs/');
        assert.strictEqual(resolveOidcRequestUrl(), 'https://tfs.corp.example/tfs/oidc');
    });

    it('does not accept an on-prem-looking host that does not match the collection host', () => {
        setEnv('https://tfs.attacker.example/tfs/oidc', 'https://tfs.corp.example/tfs/');
        assert.throws(() => resolveOidcRequestUrl(), /not a recognized Azure DevOps OIDC endpoint/);
    });
});
