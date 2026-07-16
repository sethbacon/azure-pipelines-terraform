import { describe, it, before, after } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import * as https from 'https';
import * as tls from 'tls';
import nock = require('nock');
import tasks = require('azure-pipelines-task-lib/task');
import { snRequest } from '../src/servicenow-http';
import { TLS_CERT, TLS_KEY } from './loopback-tls';
import { startConnectProxy, startRefusingConnectProxy, startHangingConnectProxy } from './proxy-connect-server';

// Direct (non-MockTestRunner) unit tests for servicenow-http.ts's agent proxy
// support (tasks.getHttpProxyConfiguration() -> a CONNECT-tunneling
// https.Agent). New file rather than an addition to L0.ts to avoid rebase
// conflicts with the kb-hardening PR, which also touches L0.ts.
describe('servicenow-http: agent proxy support', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const origGetProxy = t.getHttpProxyConfiguration;
    const origSetSecret = t.setSecret;

    // L0.ts's root-level before()/after() hooks leave nock patching Node's
    // http/https modules globally. That patching mishandles the CONNECT
    // method's authority-form request-target (nock's interceptor tries to
    // parse it as a URL and throws) -- same reason L0.ts's own real-socket
    // timeout test fully restores the real modules (see its comment). Do the
    // same for the lifetime of this describe block, which needs a real
    // CONNECT-tunneling proxy end-to-end.
    before(() => {
        nock.restore();
    });
    after(() => {
        nock.activate();
        nock.disableNetConnect();
    });

    afterEach(() => {
        t.getHttpProxyConfiguration = origGetProxy;
        t.setSecret = origSetSecret;
    });

    /**
     * Runs `fn` with tls.connect() patched to trust TLS_CERT as an additional CA,
     * so a request through the real CONNECT-tunneling ProxyTunnelAgent (which
     * calls tls.connect() itself, and which -- unlike DriftReport/ModulePublish's
     * https-client.ts -- servicenow-http.ts gives no rejectUnauthorized override
     * for) can complete a genuine, verified TLS handshake against the loopback
     * self-signed server. This exercises real certificate validation end-to-end
     * rather than disabling it, unlike NODE_TLS_REJECT_UNAUTHORIZED=0 or
     * rejectUnauthorized: false (both flagged by CodeQL's
     * disabling-certificate-validation query, and both weaker than pinning a
     * specific trusted CA).
     */
    async function withTestCaTrusted<T>(fn: () => Promise<T>): Promise<T> {
        const originalConnect = tls.connect;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow test-only patch of tls.connect's options-object overload
        (tls as any).connect = (options: tls.ConnectionOptions, callback?: () => void) =>
            originalConnect({ ...options, ca: TLS_CERT }, callback);
        try {
            return await fn();
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restoring the same test-only patch above
            (tls as any).connect = originalConnect;
        }
    }

    it('routes a request through a configured HTTP CONNECT proxy', async () => {
        const target = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"result":{"ok":true}}');
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = (target.address() as net.AddressInfo).port;

        const { server: proxy, seen } = startConnectProxy();
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;

        t.getHttpProxyConfiguration = () => ({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
            const resp = await withTestCaTrusted(() =>
                snRequest('GET', `https://127.0.0.1:${targetPort}/api/now/table/kb_knowledge`),
            );
            assert.strictEqual(resp.status, 200);
            assert.deepStrictEqual(resp.data, { result: { ok: true } });
            assert.strictEqual(seen.length, 1, 'the proxy should have seen exactly one CONNECT');
            assert.strictEqual(seen[0].target, `127.0.0.1:${targetPort}`);
        } finally {
            target.close();
            proxy.close();
        }
    });

    it('sends Proxy-Authorization and masks the proxy password as a secret when credentials are configured', async () => {
        const target = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"result":{"ok":true}}');
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = (target.address() as net.AddressInfo).port;

        const expectedAuth = `Basic ${Buffer.from('proxyuser:p@ss').toString('base64')}`;
        const { server: proxy, seen } = startConnectProxy({ requireAuthHeader: expectedAuth });
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;

        const maskedSecrets: string[] = [];
        t.setSecret = (v: string) => maskedSecrets.push(v);
        t.getHttpProxyConfiguration = () => ({
            proxyUrl: `http://127.0.0.1:${proxyPort}`,
            proxyUsername: 'proxyuser',
            proxyPassword: 'p@ss',
        });

        try {
            const resp = await withTestCaTrusted(() =>
                snRequest('GET', `https://127.0.0.1:${targetPort}/api/now/table/kb_knowledge`),
            );
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(seen.length, 1);
            assert.strictEqual(seen[0].proxyAuthorization, expectedAuth);
            assert.ok(maskedSecrets.includes('p@ss'), 'the proxy password should be registered as a secret');
        } finally {
            target.close();
            proxy.close();
        }
    });

    it('throws a clear error on a malformed proxy URL instead of an unhandled exception', async () => {
        t.getHttpProxyConfiguration = () => ({ proxyUrl: 'not a url' });
        await assert.rejects(
            snRequest('GET', 'https://127.0.0.1:1/api/now/table/kb_knowledge'),
            /Invalid proxy URL/,
        );
    });

    it('surfaces a clear error when the proxy refuses the CONNECT tunnel', async () => {
        const proxy = startRefusingConnectProxy(502);
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;
        t.getHttpProxyConfiguration = () => ({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
            await assert.rejects(
                snRequest('GET', 'https://127.0.0.1:1/api/now/table/kb_knowledge'),
                /Proxy CONNECT.*failed with status 502/,
            );
        } finally {
            proxy.close();
        }
    });

    it('times out a hung proxy CONNECT tunnel instead of hanging', async () => {
        // A proxy that accepts the TCP connection but never answers the CONNECT
        // request (a wedged/overloaded corporate proxy). The tunnel-establishment
        // handshake runs inside ProxyTunnelAgent.createConnection, before the outer
        // request's 'socket' event fires, so it is NOT covered by req.setTimeout();
        // the agent must bound it with the same configured timeout or the request
        // hangs until the agent job timeout rather than failing after timeoutMs.
        const proxy = startHangingConnectProxy();
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;
        t.getHttpProxyConfiguration = () => ({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
            await assert.rejects(
                snRequest('GET', 'https://127.0.0.1:1/api/now/table/kb_knowledge', { timeoutMs: 150 }),
                /timed out after 150ms/,
            );
        } finally {
            proxy.close();
        }
    });

    it('connects directly (no proxy) when the agent has none configured', async () => {
        const target = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"result":{"ok":true}}');
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = (target.address() as net.AddressInfo).port;
        t.getHttpProxyConfiguration = () => undefined;

        try {
            // No proxy configured -> agent stays undefined -> https.request() falls
            // back to https.globalAgent, which never calls our patched tls.connect().
            // Verify the (production) https.globalAgent trusts TLS_CERT for this one
            // request instead, the equivalent of the CA pinning above.
            const originalCreateSecureContext = https.globalAgent.options.ca;
            https.globalAgent.options.ca = TLS_CERT;
            try {
                const resp = await snRequest('GET', `https://127.0.0.1:${targetPort}/api/now/table/kb_knowledge`);
                assert.strictEqual(resp.status, 200);
            } finally {
                https.globalAgent.options.ca = originalCreateSecureContext;
            }
        } finally {
            target.close();
        }
    });
});
