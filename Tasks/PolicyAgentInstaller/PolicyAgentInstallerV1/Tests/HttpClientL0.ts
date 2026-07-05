import { describe, it } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import tasks = require('azure-pipelines-task-lib/task');
import { fetchWithTimeout, fetchJson, fetchText, fetchTextAllow404, fetchBuffer, fetchBufferAllow404 } from '../src/http-client';

// Direct (non-MockTestRunner) unit tests for the http-client timeout guard.
// These run in the mocha parent process; the MockTestRunner integration tests in
// L0.ts run in child processes and are unaffected.

describe('http-client: fetchWithTimeout', () => {
    it('rejects a non-https URL before opening a connection', async () => {
        await assert.rejects(
            fetchWithTimeout('http://insecure.example.com/x', 1000, async (r) => r.text()),
            /InsecureUrlRejected|insecure/i,
        );
    });

    it('aborts a hung connection and reports the timeout', async () => {
        // A bare TCP server that accepts the socket but never completes the TLS
        // handshake — the AbortController must fire and surface a timeout error.
        const server = net.createServer(() => { /* accept and stall */ });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            await assert.rejects(
                fetchWithTimeout(`https://127.0.0.1:${port}/x`, 150, async (r) => r.text()),
                /timed out after 150ms/,
            );
        } finally {
            server.close();
        }
    });

    it('follows an https-to-https redirect', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            if (url === 'https://example.com/start') {
                return new Response(null, { status: 302, headers: { Location: 'https://example.com/final' } });
            }
            return new Response('ok', { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        try {
            const result = await fetchWithTimeout('https://example.com/start', 1000, async (r) => r.text());
            assert.strictEqual(result, 'ok');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects a redirect that downgrades to http://', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(null, { status: 302, headers: { Location: 'http://attacker.example.com/payload' } })
        ) as unknown as typeof globalThis.fetch;
        try {
            await assert.rejects(
                () => fetchWithTimeout('https://example.com/start', 1000, async (r) => r.text()),
                /InsecureUrlRejected/
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('refuses an off-host redirect even when it stays https', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(null, { status: 302, headers: { Location: 'https://evil.example.net/payload' } })
        ) as unknown as typeof globalThis.fetch;
        try {
            await assert.rejects(
                () => fetchWithTimeout('https://example.com/start', 1000, async (r) => r.text()),
                /off-host redirect/
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('aborts a redirect loop after the hop limit', async () => {
        const originalFetch = globalThis.fetch;
        // Always redirect to a same-host URL -> exceeds MAX_REDIRECTS.
        globalThis.fetch = (async () =>
            new Response(null, { status: 302, headers: { Location: 'https://example.com/loop' } })
        ) as unknown as typeof globalThis.fetch;
        try {
            await assert.rejects(
                () => fetchWithTimeout('https://example.com/loop', 1000, async (r) => r.text()),
                /Too many redirects/
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('http-client: fetchJson / fetchText / fetchBuffer', () => {
    let originalFetch: typeof globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const origProxy = t.getHttpProxyConfiguration;
    const origLoc = t.loc;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        t.getHttpProxyConfiguration = () => undefined;
        t.loc = (k: string, ...args: unknown[]) => `${k} ${args.join(' ')}`.trim();
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        t.getHttpProxyConfiguration = origProxy;
        t.loc = origLoc;
    });

    it('fetchJson parses a 200 JSON body', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ ok: true, n: 7 }), { status: 200 })) as unknown as typeof globalThis.fetch;
        const data = await fetchJson<{ ok: boolean; n: number }>('https://api.example.com/v');
        assert.deepStrictEqual(data, { ok: true, n: 7 });
    });

    it('fetchJson throws on a non-OK status and does not retry a 4xx', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response('nope', { status: 404 });
        }) as unknown as typeof globalThis.fetch;
        await assert.rejects(fetchJson('https://api.example.com/v'), /RegistryRequestFailed|404/);
        assert.strictEqual(calls, 1, '4xx must not be retried');
    });

    it('fetchText returns a 200 text body', async () => {
        globalThis.fetch = (async () =>
            new Response('hello-sums', { status: 200 })) as unknown as typeof globalThis.fetch;
        assert.strictEqual(await fetchText('https://files.example.com/SHA256SUMS'), 'hello-sums');
    });

    it('fetchText retries a transient 5xx and then succeeds', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return calls === 1
                ? new Response('busy', { status: 503 })
                : new Response('payload', { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        const text = await fetchText('https://files.example.com/SHA256SUMS');
        assert.strictEqual(text, 'payload');
        assert.strictEqual(calls, 2, '5xx should trigger exactly one retry here');
    });

    it('fetchText retries a network error and then gives up after the attempt limit', async () => {
        let calls = 0;
        globalThis.fetch = (async () => { calls++; throw new TypeError('network down'); }) as unknown as typeof globalThis.fetch;
        await assert.rejects(fetchText('https://files.example.com/SHA256SUMS'), /network down/);
        assert.strictEqual(calls, 3, 'network errors are retried up to the attempt limit');
    });

    it('fetchTextAllow404 returns null on 404 but text on 200', async () => {
        globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof globalThis.fetch;
        assert.strictEqual(await fetchTextAllow404('https://files.example.com/SHA256SUMS'), null);

        globalThis.fetch = (async () => new Response('sums-body', { status: 200 })) as unknown as typeof globalThis.fetch;
        assert.strictEqual(await fetchTextAllow404('https://files.example.com/SHA256SUMS'), 'sums-body');
    });

    it('fetchBuffer returns 200 bytes', async () => {
        globalThis.fetch = (async () =>
            new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof globalThis.fetch;
        const buf = await fetchBuffer('https://files.example.com/sig');
        assert.deepStrictEqual(Array.from(buf), [1, 2, 3]);
    });

    it('fetchBuffer throws on a non-OK status', async () => {
        globalThis.fetch = (async () =>
            new Response('', { status: 403 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(fetchBuffer('https://files.example.com/sig'), /Failed to fetch .*HTTP 403/);
    });

    it('fetchBufferAllow404 returns null on 404 but bytes on 200', async () => {
        globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof globalThis.fetch;
        assert.strictEqual(await fetchBufferAllow404('https://files.example.com/sig'), null);

        globalThis.fetch = (async () =>
            new Response(new Uint8Array([4, 5, 6]), { status: 200 })) as unknown as typeof globalThis.fetch;
        const buf = await fetchBufferAllow404('https://files.example.com/sig');
        assert.deepStrictEqual(buf && Array.from(buf), [4, 5, 6]);
    });

    it('routes through a proxy with embedded credentials when configured', async () => {
        let seenInit: RequestInit | undefined;
        t.getHttpProxyConfiguration = () => ({
            proxyUrl: 'http://proxy.example.com:8080',
            proxyUsername: 'user',
            proxyPassword: 'p@ss',
        });
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
            seenInit = init;
            return new Response('{}', { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        await fetchJson('https://api.example.com/v');
        // A dispatcher (undici ProxyAgent) must have been attached.
        assert.ok(seenInit && 'dispatcher' in seenInit, 'proxy dispatcher should be set');
    });

    it('masks the proxy password as a secret when credentials are configured', async () => {
        const setSecretCalls: string[] = [];
        const origSetSecret = t.setSecret;
        t.setSecret = (v: string) => setSecretCalls.push(v);
        t.getHttpProxyConfiguration = () => ({
            proxyUrl: 'http://proxy.example.com:8080',
            proxyUsername: 'user',
            proxyPassword: 'p@ss',
        });
        globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch;
        try {
            await fetchJson('https://api.example.com/v');
            assert.ok(setSecretCalls.includes('p@ss'), 'proxy password should be registered as a secret');
        } finally {
            t.setSecret = origSetSecret;
        }
    });

    it('throws a clear error on a malformed proxy URL instead of an unhandled TypeError', async () => {
        t.getHttpProxyConfiguration = () => ({
            proxyUrl: 'not a url',
            proxyUsername: 'user',
            proxyPassword: 'p@ss',
        });
        globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(fetchJson('https://api.example.com/v'), /Invalid proxy URL/);
    });

    it('uses a proxy without credentials when username is empty', async () => {
        let seenInit: RequestInit | undefined;
        t.getHttpProxyConfiguration = () => ({
            proxyUrl: 'http://proxy.example.com:8080',
            proxyUsername: '',
            proxyPassword: '',
        });
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
            seenInit = init;
            return new Response('{}', { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        await fetchJson('https://api.example.com/v');
        assert.ok(seenInit && 'dispatcher' in seenInit, 'proxy dispatcher should be set');
    });
});
