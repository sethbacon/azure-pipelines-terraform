import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { TokenGenerator, generateIdToken } from '../src/id-token-generator';

/**
 * Direct unit tests for the OIDC ID-token generator used by the Workload
 * Identity Federation fallback. The federated token is fetched from the
 * agent's SYSTEM_OIDCREQUESTURI with a Bearer access token, retried with
 * exponential backoff, and registered as a secret. fetch and the task-lib
 * surface are stubbed so no network or agent state is touched.
 */
describe('OIDC ID token generator — retry, timeout & secret handling', function () {
    // The all-fail path waits 200ms + 400ms between three attempts.
    this.timeout(10000);

    let originalFetch: typeof globalThis.fetch;
    let originalEnv: string | undefined;
    let originalCollectionUri: string | undefined;
    let originalTfsCollectionUri: string | undefined;
    const setSecretCalls: string[] = [];
    let accessTokenValue: string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = {
        debug: t.debug,
        getEndpointAuthorizationParameter: t.getEndpointAuthorizationParameter,
        setSecret: t.setSecret,
        loc: t.loc,
    };

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalEnv = process.env['SYSTEM_OIDCREQUESTURI'];
        originalCollectionUri = process.env['SYSTEM_COLLECTIONURI'];
        originalTfsCollectionUri = process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'];
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/oidc';
        delete process.env['SYSTEM_COLLECTIONURI'];
        delete process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'];
        setSecretCalls.length = 0;
        accessTokenValue = 'access-token';
        t.debug = () => { /* silence */ };
        t.getEndpointAuthorizationParameter = () => accessTokenValue;
        t.setSecret = (s: string) => { setSecretCalls.push(s); };
        t.loc = (k: string) => k;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalEnv === undefined) {
            delete process.env['SYSTEM_OIDCREQUESTURI'];
        } else {
            process.env['SYSTEM_OIDCREQUESTURI'] = originalEnv;
        }
        if (originalCollectionUri === undefined) {
            delete process.env['SYSTEM_COLLECTIONURI'];
        } else {
            process.env['SYSTEM_COLLECTIONURI'] = originalCollectionUri;
        }
        if (originalTfsCollectionUri === undefined) {
            delete process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'];
        } else {
            process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'] = originalTfsCollectionUri;
        }
        t.debug = taskOrig.debug;
        t.getEndpointAuthorizationParameter = taskOrig.getEndpointAuthorizationParameter;
        t.setSecret = taskOrig.setSecret;
        t.loc = taskOrig.loc;
    });

    it('acquires the federated token, registers it as a secret, and POSTs with the Bearer access token', async () => {
        let seenUrl = '';
        let seenInit: RequestInit = {};
        globalThis.fetch = (async (url: string, init: RequestInit) => {
            seenUrl = url;
            seenInit = init;
            return new Response(JSON.stringify({ oidcToken: 'fed-token' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const token = await new TokenGenerator().generate('sc-123');

        assert.strictEqual(token, 'fed-token');
        // Both the agent OAuth access token (registered before the request) and the
        // returned federated token must be masked as secrets (see #364).
        assert.deepStrictEqual(setSecretCalls, ['access-token', 'fed-token'], 'access token and federated token must both be registered as secrets');
        assert.ok(seenUrl.startsWith('https://vstoken.dev.azure.com/oidc?'), 'posts to the OIDC request URI');
        assert.ok(seenUrl.includes('serviceConnectionId=sc-123'), 'includes the service connection id');
        assert.strictEqual(seenInit.method, 'POST');
        const headers = seenInit.headers as Record<string, string>;
        assert.strictEqual(headers['Authorization'], 'Bearer access-token');
        // This token exchange has no legitimate redirect -- the Bearer access
        // token must never be silently carried to a redirect target (#353).
        assert.strictEqual(seenInit.redirect, 'error');
    });

    it('throws when SYSTEM_OIDCREQUESTURI is not set', async () => {
        delete process.env['SYSTEM_OIDCREQUESTURI'];
        await assert.rejects(new TokenGenerator().generate('sc-123'), /SYSTEM_OIDCREQUESTURI is not set/);
    });

    it('throws when SYSTEM_OIDCREQUESTURI is not an https:// URL (#353)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'http://vstoken.dev.azure.com/oidc';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /must be an https:\/\/ URL/);
        assert.strictEqual(called, false, 'must not call fetch with a non-https request URI');
    });

    it('rejects a *.visualstudio.com host when no collection URI vouches for its org (#554)', async () => {
        // Behavior change (#554 reopen): the pre-#554 code accepted ANY
        // *.visualstudio.com host on the bare suffix match. It now fails closed
        // when no collection variable exposes a *.visualstudio.com org to
        // compare against (here neither is set — beforeEach clears both), since
        // a bare suffix match would admit any tenant's org. The legitimate
        // legacy-domain case is covered by the same-org test below, where the
        // collection URI is the matching *.visualstudio.com org.
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://myorg.visualstudio.com/_apis/distributedtask/hubs/build/plans/1/jobs/2/oidctoken';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /OidcRequestUriHostNotAllowed/);
        assert.strictEqual(called, false, 'must not send the Bearer access token to a *.visualstudio.com host no collection URI vouches for');
    });

    it('accepts an on-prem host that matches the System.CollectionUri host (#493)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://tfs.corp.example/tfs/DefaultCollection/_apis/oidctoken';
        process.env['SYSTEM_COLLECTIONURI'] = 'https://tfs.corp.example/tfs/DefaultCollection/';
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ oidcToken: 'onprem-token' }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const token = await new TokenGenerator().generate('sc-123');
        assert.strictEqual(token, 'onprem-token');
    });

    it('accepts an on-prem host that matches the System.TeamFoundationCollectionUri host (#493)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://azdo-server.internal/_apis/oidctoken';
        process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'] = 'https://azdo-server.internal/DefaultCollection/';
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ oidcToken: 'onprem-tfs-token' }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const token = await new TokenGenerator().generate('sc-123');
        assert.strictEqual(token, 'onprem-tfs-token');
    });

    it('rejects a cross-org *.visualstudio.com host when the collection URI names a different org (#554)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://attackerorg.visualstudio.com/_apis/oidctoken';
        process.env['SYSTEM_COLLECTIONURI'] = 'https://myorg.visualstudio.com/';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /OidcRequestUriHostNotAllowed/);
        assert.strictEqual(called, false, 'must not send the Bearer access token to another tenant\'s org host');
    });

    it('accepts the collection\'s own *.visualstudio.com org host (#554)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://myorg.visualstudio.com/_apis/oidctoken';
        process.env['SYSTEM_COLLECTIONURI'] = 'https://myorg.visualstudio.com/';
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ oidcToken: 'same-org-token' }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const token = await new TokenGenerator().generate('sc-123');
        assert.strictEqual(token, 'same-org-token');
    });

    it('still accepts vstoken.dev.azure.com when the collection URI is a *.visualstudio.com org (#554)', async () => {
        // The standard cloud OIDC endpoint carries no org label at all -- the
        // org tightening must never reject it, whatever form the collection
        // URI takes.
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/oidc';
        process.env['SYSTEM_COLLECTIONURI'] = 'https://myorg.visualstudio.com/';
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ oidcToken: 'vstoken-token' }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const token = await new TokenGenerator().generate('sc-123');
        assert.strictEqual(token, 'vstoken-token');
    });

    it('rejects a *.visualstudio.com host when the collection URI is the dev.azure.com form (#554)', async () => {
        // Behavior change (#554 reopen): a dev.azure.com-form collection URI
        // carries its org in the PATH, not the host, so no org comparison is
        // possible. The pre-#554 code fell through to the broad suffix and
        // accepted the host; it now fails closed -- a dev.azure.com-era org
        // never legitimately mints tokens at a *.visualstudio.com host, so the
        // Bearer access token must not be sent there.
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://myorg.visualstudio.com/_apis/oidctoken';
        process.env['SYSTEM_COLLECTIONURI'] = 'https://dev.azure.com/myorg/';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /OidcRequestUriHostNotAllowed/);
        assert.strictEqual(called, false, 'must not send the Bearer access token to a *.visualstudio.com host when the collection URI is the dev.azure.com form');
    });

    it('rejects a foreign host and never sends the Bearer access token to it (#493)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://evil.example.com/oidc';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /OidcRequestUriHostNotAllowed/);
        assert.strictEqual(called, false, 'must not call fetch with a non-ADO request URI host');
    });

    it('rejects a foreign host even when a collection URI is set for a different host (#493)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://evil.example.com/oidc';
        process.env['SYSTEM_COLLECTIONURI'] = 'https://tfs.corp.example/tfs/DefaultCollection/';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /OidcRequestUriHostNotAllowed/);
        assert.strictEqual(called, false, 'must not call fetch with a non-ADO request URI host');
    });

    it('rejects a lookalike host that merely embeds an allowed suffix (#493)', async () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://dev.azure.com.evil.example/oidc';
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /OidcRequestUriHostNotAllowed/);
        assert.strictEqual(called, false, 'must not call fetch with a lookalike host');
    });

    it('throws when the SystemVssConnection access token is unavailable', async () => {
        accessTokenValue = undefined;
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /AccessToken is not available/);
        assert.strictEqual(called, false, 'must not call fetch without an access token');
    });

    it('retries on a transient failure and then succeeds', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            if (calls === 1) {
                throw new Error('ECONNRESET');
            }
            return new Response(JSON.stringify({ oidcToken: 'after-retry' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const token = await new TokenGenerator().generate('sc-123');
        assert.strictEqual(token, 'after-retry');
        assert.strictEqual(calls, 2, 'should have retried exactly once');
    });

    it('gives up after the maximum number of retries and throws the last error', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            throw new Error('always-down');
        }) as unknown as typeof globalThis.fetch;

        await assert.rejects(new TokenGenerator().generate('sc-123'), /Failed to acquire federated token.*always-down/);
        assert.strictEqual(calls, 3, 'should attempt MAX_RETRIES times');
    });

    it('throws a clear HTTP error on a non-OK response and does not retry a deterministic 4xx (#353)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response('nope', { status: 403, statusText: 'Forbidden' });
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /HTTP 403 Forbidden/);
        assert.strictEqual(calls, 1, 'a deterministic 4xx must not be retried');
    });

    it('retries a transient 5xx and then gives up after the attempt limit (#353)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response('busy', { status: 503, statusText: 'Service Unavailable' });
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /HTTP 503/);
        assert.strictEqual(calls, 3, 'a transient 5xx should be retried up to the attempt limit');
    });

    it('retries a 429 and then succeeds (#584)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            if (calls === 1) {
                return new Response('slow down', { status: 429, statusText: 'Too Many Requests' });
            }
            return new Response(JSON.stringify({ oidcToken: 'after-429' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const token = await new TokenGenerator().generate('sc-123');
        assert.strictEqual(token, 'after-429', 'a 429 must be treated as transient and retried');
        assert.strictEqual(calls, 2, 'should have retried exactly once after the 429');
    });

    it('honors a capped Retry-After from a 429 over the default backoff (#584)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            if (calls === 1) {
                return new Response('slow down', {
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: { 'Retry-After': '1' },
                });
            }
            return new Response(JSON.stringify({ oidcToken: 'after-retry-after' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const started = Date.now();
        const token = await new TokenGenerator().generate('sc-123');
        const elapsed = Date.now() - started;
        assert.strictEqual(token, 'after-retry-after');
        assert.strictEqual(calls, 2);
        // The default first-retry backoff is 200ms; Retry-After: 1 must stretch
        // the wait to ~1000ms. A generous lower bound keeps this robust on CI.
        assert.ok(elapsed >= 900, `expected the 1s Retry-After to be honored, waited only ${elapsed}ms`);
    });

    it('throws the localized error when the response omits oidcToken', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ somethingElse: true }), { status: 200 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /Error_FederatedTokenAquisitionFailed/);
    });

    it('maps an abort/timeout to a clear timeout error', async () => {
        globalThis.fetch = (async () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(new TokenGenerator().generate('sc-123'), /Timed out acquiring federated token/);
    });

    it('generateIdToken delegates to TokenGenerator.generate', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ oidcToken: 'wrapper-token' }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const token = await generateIdToken('sc-456');
        assert.strictEqual(token, 'wrapper-token');
        assert.deepStrictEqual(setSecretCalls, ['access-token', 'wrapper-token']);
    });
});
