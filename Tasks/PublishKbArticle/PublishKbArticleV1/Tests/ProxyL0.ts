import { describe, it, before, after } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import * as https from 'https';
import nock = require('nock');
import tasks = require('azure-pipelines-task-lib/task');
import { snRequest } from '../src/servicenow-http';
import { TLS_CERT, TLS_KEY } from './loopback-tls';
import { startConnectProxy, startRefusingConnectProxy } from './proxy-connect-server';

// Direct (non-MockTestRunner) unit tests for servicenow-http.ts's agent proxy
// support (tasks.getHttpProxyConfiguration() -> a CONNECT-tunneling
// https.Agent). New file rather than an addition to L0.ts to avoid rebase
// conflicts with the kb-hardening PR, which also touches L0.ts.
//
// A few tests below set process.env.NODE_TLS_REJECT_UNAUTHORIZED='0' for their
// duration, restoring it in a finally block. This is TEST-ONLY: snRequest()
// (unlike the DriftReport/ModulePublish https-client.ts) has no
// rejectUnauthorized/ca override of its own, so it is the only way to make it
// accept the loopback self-signed cert used to exercise a real CONNECT tunnel
// end-to-end. Every server involved is bound to 127.0.0.1, the flag is
// restored immediately after each test, and no production code path is
// affected.
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

        // servicenow-http.ts has no rejectUnauthorized input of its own; disable
        // TLS verification process-wide for this one test so the self-signed
        // loopback cert is accepted end-to-end through the tunnel.
        const originalReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        t.getHttpProxyConfiguration = () => ({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
            const resp = await snRequest('GET', `https://127.0.0.1:${targetPort}/api/now/table/kb_knowledge`);
            assert.strictEqual(resp.status, 200);
            assert.deepStrictEqual(resp.data, { result: { ok: true } });
            assert.strictEqual(seen.length, 1, 'the proxy should have seen exactly one CONNECT');
            assert.strictEqual(seen[0].target, `127.0.0.1:${targetPort}`);
        } finally {
            target.close();
            proxy.close();
            if (originalReject === undefined) {
                delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            } else {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalReject;
            }
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

        const originalReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
            const resp = await snRequest('GET', `https://127.0.0.1:${targetPort}/api/now/table/kb_knowledge`);
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(seen.length, 1);
            assert.strictEqual(seen[0].proxyAuthorization, expectedAuth);
            assert.ok(maskedSecrets.includes('p@ss'), 'the proxy password should be registered as a secret');
        } finally {
            target.close();
            proxy.close();
            if (originalReject === undefined) {
                delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            } else {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalReject;
            }
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

    it('connects directly (no proxy) when the agent has none configured', async () => {
        const target = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"result":{"ok":true}}');
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = (target.address() as net.AddressInfo).port;
        t.getHttpProxyConfiguration = () => undefined;

        const originalReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
            const resp = await snRequest('GET', `https://127.0.0.1:${targetPort}/api/now/table/kb_knowledge`);
            assert.strictEqual(resp.status, 200);
        } finally {
            target.close();
            if (originalReject === undefined) {
                delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            } else {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalReject;
            }
        }
    });
});
