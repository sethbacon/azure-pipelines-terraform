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

    it('throws on a non-OK response', async () => {
        globalThis.fetch = (async () =>
            new Response('bad request', { status: 400, statusText: 'Bad Request' })) as unknown as typeof globalThis.fetch;
        await assert.rejects(exchangeOidcForUpst('jwt', VALID_DOMAIN, 'client', publicKey), /HTTP 400/);
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
});
