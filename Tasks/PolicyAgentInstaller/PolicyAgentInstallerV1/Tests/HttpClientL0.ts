import { describe, it } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import tasks = require('azure-pipelines-task-lib/task');
import { fetchWithTimeout, fetchJson, fetchText, fetchBuffer } from '../src/http-client';

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

    it('fetchJson throws on a non-OK status', async () => {
        globalThis.fetch = (async () =>
            new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(fetchJson('https://api.example.com/v'), /RegistryRequestFailed|500/);
    });

    it('fetchText returns a 200 text body', async () => {
        globalThis.fetch = (async () =>
            new Response('hello-sums', { status: 200 })) as unknown as typeof globalThis.fetch;
        assert.strictEqual(await fetchText('https://files.example.com/SHA256SUMS'), 'hello-sums');
    });

    it('fetchText throws on a non-OK status', async () => {
        globalThis.fetch = (async () =>
            new Response('', { status: 404 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(fetchText('https://files.example.com/missing'), /Failed to fetch .*HTTP 404/);
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
