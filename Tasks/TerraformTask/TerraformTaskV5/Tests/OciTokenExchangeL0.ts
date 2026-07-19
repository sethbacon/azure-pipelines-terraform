import * as assert from 'assert';
import * as crypto from 'crypto';
import { exchangeOidcForUpst, validateIdentityDomainUrl } from '../src/oci-token-exchange';

/**
 * Direct unit tests for the OCI WIF token-exchange transport hardening.
 * The federated OIDC bearer JWT is POSTed to an operator-supplied identity
 * domain URL, so the destination is validated and redirects are refused
 * before the token leaves the agent. fetch is stubbed so no network is hit.
 */
describe('OCI token exchange — URL validation & transport', function () {
    // The persistent-failure retry paths wait 200ms + 400ms between three attempts.
    this.timeout(10000);

    // A real RSA public key so publicKeyToBase64Der succeeds on the happy path.
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const VALID_DOMAIN = 'https://idcs-abc123.identity.oraclecloud.com';

    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    /* validateIdentityDomainUrl (pure) */

    it('accepts a genuine OCI Identity Domains HTTPS URL', () => {
        const u = validateIdentityDomainUrl(VALID_DOMAIN);
        assert.strictEqual(u.hostname, 'idcs-abc123.identity.oraclecloud.com');
    });

    it('accepts OCI government-realm identity hosts', () => {
        assert.doesNotThrow(() => validateIdentityDomainUrl('https://idcs-x.identity.oraclegovcloud.com'));
    });

    it('rejects a non-HTTPS scheme', () => {
        assert.throws(() => validateIdentityDomainUrl('http://idcs-x.identity.oraclecloud.com'), /HTTPS/);
    });

    it('rejects a host outside the OCI Identity Domains realms', () => {
        assert.throws(() => validateIdentityDomainUrl('https://evil.example.com'), /not an OCI Identity Domains endpoint/);
    });

    it('rejects a look-alike suffix host', () => {
        assert.throws(
            () => validateIdentityDomainUrl('https://identity.oraclecloud.com.evil.example'),
            /not an OCI Identity Domains endpoint/
        );
    });

    it('rejects a malformed URL', () => {
        assert.throws(() => validateIdentityDomainUrl('not a url'), /not a valid URL/);
    });

    /* exchangeOidcForUpst (fetch stubbed) */

    it('rejects before any network call when the domain is invalid', async () => {
        let called = false;
        globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof globalThis.fetch;
        await assert.rejects(
            exchangeOidcForUpst('jwt', 'http://evil.example.com', 'client', publicKey),
            /HTTPS/
        );
        assert.strictEqual(called, false, 'fetch must not be called for an invalid domain');
    });

    it('posts to the identity domain token endpoint with manual redirect and returns the UPST', async () => {
        let seenUrl = '';
        let seenRedirect: RequestRedirect | undefined;
        globalThis.fetch = (async (url: string, init: RequestInit) => {
            seenUrl = url;
            seenRedirect = init.redirect;
            return new Response(JSON.stringify({ access_token: 'the-upst' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const upst = await exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey);
        assert.strictEqual(upst, 'the-upst');
        assert.strictEqual(seenUrl, `${VALID_DOMAIN}/oauth2/v1/token`);
        assert.strictEqual(seenRedirect, 'manual');
    });

    it('falls back to the token field when access_token is absent', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ token: 'alt-upst' }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const upst = await exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey);
        assert.strictEqual(upst, 'alt-upst');
    });

    it('throws when the response omits a token', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /missing access_token/);
    });

    it('throws a clear, truncated error on a non-JSON 200 response instead of a raw SyntaxError', async () => {
        globalThis.fetch = (async () =>
            new Response('<html>captive portal</html>', { status: 200 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(
            exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey),
            (err: unknown) => {
                assert.ok(err instanceof Error, 'should throw an Error');
                assert.ok(!(err instanceof SyntaxError), 'must not be a raw unwrapped SyntaxError');
                assert.match(err.message, /OCI token exchange returned a non-JSON response/);
                assert.ok(err.message.includes('captive portal'), 'should include the (truncated) response body');
                return true;
            },
        );
    });

    it('throws on a non-OK response', async () => {
        globalThis.fetch = (async () =>
            new Response('bad request', { status: 400, statusText: 'Bad Request' })) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /HTTP 400/);
    });

    /* #647: scrub a reflected request secret from an echoed error body */

    it('scrubs the reflected subject_token from a non-OK error body (#647)', async () => {
        const secretJwt = 'eyJhbGciOiJSUzI1NiJ9.super-secret-subject-token.sig';
        globalThis.fetch = (async () =>
            new Response(`invalid_grant: subject_token ${secretJwt} rejected`, { status: 400, statusText: 'Bad Request' })) as unknown as typeof globalThis.fetch;
        await assert.rejects(
            exchangeOidcForUpst(secretJwt, VALID_DOMAIN, 'client', publicKey),
            (err: unknown) => {
                assert.ok(err instanceof Error, 'should throw an Error');
                assert.ok(!err.message.includes(secretJwt), 'the reflected subject_token must be scrubbed from the failure message');
                assert.match(err.message, /HTTP 400/, 'keeps the status for diagnostics');
                assert.ok(err.message.includes('***'), 'the scrubbed secret is replaced with a redaction marker');
                return true;
            },
        );
    });

    it('scrubs the reflected subject_token from a non-JSON 200 body (#647)', async () => {
        const secretJwt = 'eyJhbGciOiJSUzI1NiJ9.another-secret-subject-token.sig';
        globalThis.fetch = (async () =>
            new Response(`<html>echoed ${secretJwt}</html>`, { status: 200 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(
            exchangeOidcForUpst(secretJwt, VALID_DOMAIN, 'client', publicKey),
            (err: unknown) => {
                assert.ok(err instanceof Error, 'should throw an Error');
                assert.ok(!err.message.includes(secretJwt), 'the reflected subject_token must be scrubbed from the non-JSON failure message');
                assert.match(err.message, /non-JSON response/);
                return true;
            },
        );
    });

    it('refuses an opaque redirect from the token endpoint', async () => {
        globalThis.fetch = (async () => {
            const r = new Response(null, { status: 200 });
            Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
            return r;
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /redirect/);
    });

    it('refuses a raw 3xx redirect from the token endpoint', async () => {
        globalThis.fetch = (async () =>
            new Response(null, { status: 302 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /redirect/);
    });

    it('maps an abort/timeout to a clear error', async () => {
        globalThis.fetch = (async () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /Timed out/);
    });

    it('wraps a generic network error', async () => {
        globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /Failed to exchange/);
    });

    /* #585: bounded exponential-backoff retry (network + 5xx only, never a 4xx) */

    it('retries a transient network error then succeeds (#585)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            if (calls === 1) {
                throw new Error('ECONNRESET');
            }
            return new Response(JSON.stringify({ access_token: 'after-retry' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const upst = await exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey);
        assert.strictEqual(upst, 'after-retry');
        assert.strictEqual(calls, 2, 'should have retried the transient failure exactly once');
    });

    it('retries a transient 5xx then succeeds (#585)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return calls === 1
                ? new Response('busy', { status: 503, statusText: 'Service Unavailable' })
                : new Response(JSON.stringify({ access_token: 'after-5xx' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const upst = await exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey);
        assert.strictEqual(upst, 'after-5xx');
        assert.strictEqual(calls, 2);
    });

    it('does not retry a received 4xx (#585)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response('bad', { status: 400, statusText: 'Bad Request' });
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /HTTP 400/);
        assert.strictEqual(calls, 1, 'a deterministic 4xx must not be retried');
    });

    it('does not retry a refused redirect (#585)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response(null, { status: 302 });
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /redirect/);
        assert.strictEqual(calls, 1, 'a refused redirect must not be retried');
    });

    it('gives up after the maximum number of attempts on a persistent 5xx (#585)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response('busy', { status: 503, statusText: 'Service Unavailable' });
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /HTTP 503/);
        assert.strictEqual(calls, 3, 'a persistent 5xx should be retried up to the attempt limit');
    });

    it('retries a 429 and then succeeds (sibling re-sweep)', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            if (calls === 1) {
                return new Response('slow down', { status: 429, statusText: 'Too Many Requests' });
            }
            return new Response(JSON.stringify({ access_token: 'after-429' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const upst = await exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey);
        assert.strictEqual(upst, 'after-429', 'a 429 must be treated as transient and retried');
        assert.strictEqual(calls, 2, 'should have retried exactly once after the 429');
    });

    it('honors a capped Retry-After from a 429 over the default backoff (sibling re-sweep)', async () => {
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
            return new Response(JSON.stringify({ access_token: 'after-retry-after' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const started = Date.now();
        const upst = await exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey);
        const elapsed = Date.now() - started;
        assert.strictEqual(upst, 'after-retry-after');
        assert.strictEqual(calls, 2);
        // The default first-retry backoff is 200ms; Retry-After: 1 must stretch
        // the wait to ~1000ms. A generous lower bound keeps this robust on CI.
        assert.ok(elapsed >= 900, `expected the 1s Retry-After to be honored, waited only ${elapsed}ms`);
    });
});
