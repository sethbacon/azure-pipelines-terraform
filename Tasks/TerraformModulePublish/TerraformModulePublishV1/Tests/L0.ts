import { describe, it } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import * as https from 'https';
import * as path from 'path';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import tasks = require('azure-pipelines-task-lib/task');
import { HttpClient, HttpResponse, createHttpsClient, parseJson, retryHttp, truncateBody } from '../src/http';
import * as priv from '../src/private-publisher';
import * as hcp from '../src/hcp-publisher';
import { TLS_CERT, TLS_KEY } from './loopback-tls';
import { startConnectProxy, startRefusingConnectProxy, startHangingConnectProxy } from './proxy-connect-server';
// Direct unit tests for the shared retry.ts module (retryAsync + parseRetryAfterMs).
import './RetryL0';
// Contract test pinning the shared https-client's no-destination-host-restriction design (#785).
import './HttpsClientHostHandlingByDesignL0';

const noop = (): void => {
    /* suppress log output during tests */
};

interface Call {
    method: string;
    url: string;
    body?: string;
}

/** Builds a fake HttpClient that returns the given responses in order (repeating the last). */
function fakeClient(responses: HttpResponse[]): { client: HttpClient; calls: Call[] } {
    const calls: Call[] = [];
    let i = 0;
    const client: HttpClient = (method, url, _headers, body) => {
        calls.push({ method, url, body });
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return Promise.resolve(response);
    };
    return { client, calls };
}

describe('http client transport', () => {
    it('refuses to send credentials over a non-HTTPS URL', async () => {
        const client = createHttpsClient(true);
        await assert.rejects(
            client('GET', 'http://insecure.example.com/api', { Authorization: 'Bearer k' }),
            /non-HTTPS/,
        );
    });

    it('refuses a non-HTTPS URL even when rejectUnauthorized (TLS verification) is disabled', async () => {
        // The https-only guard must be independent of rejectUnauthorized -- disabling
        // certificate verification must never also disable the https-only requirement.
        const client = createHttpsClient(false);
        await assert.rejects(
            client('GET', 'http://insecure.example.com/api', { Authorization: 'Bearer k' }),
            /non-HTTPS/,
        );
    });

    it('times out a hung connection instead of hanging', async () => {
        // A bare TCP server that accepts the socket but never completes the TLS
        // handshake — req.setTimeout must fire and reject.
        const server = net.createServer(() => { /* accept and stall */ });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(true, 150);
            await assert.rejects(
                client('GET', `https://127.0.0.1:${port}/api`, {}),
                /timed out after 150ms/,
            );
        } finally {
            server.close();
        }
    });

    it('completes a request against a loopback HTTPS server', async () => {
        // Exercises the shared client end-to-end against a real TLS connection
        // (the only other real-server test in this suite is the timeout test
        // above, which never completes a TLS handshake).
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"ok":true}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(false); // accept the self-signed cert
            const resp = await client('GET', `https://127.0.0.1:${port}/api`, { Authorization: 'Bearer k' });
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(resp.body, '{"ok":true}');
        } finally {
            server.close();
        }
    });

    it('surfaces response headers (#633) so a 429 Retry-After can reach retryHttp', async () => {
        // Real end-to-end round-trip (not a hand-built fixture): HttpResponse.headers
        // must carry the server's actual response headers, case-preserved by Node,
        // rather than being dropped as before this fix.
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 429;
            res.setHeader('Retry-After', '2');
            res.end('{"error":"slow down"}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(false);
            const resp = await client('GET', `https://127.0.0.1:${port}/api`, {});
            assert.strictEqual(resp.status, 429);
            // Node lowercases header names on IncomingMessage.headers.
            assert.strictEqual(resp.headers?.['retry-after'], '2');
        } finally {
            server.close();
        }
    });

    it('rejects a self-signed certificate when rejectUnauthorized is true (the default)', async () => {
        // Secure-default counterpart to the test above: with TLS verification ON
        // (the default), the exact same self-signed loopback server must be
        // rejected with a certificate-verification error rather than silently
        // succeeding. Without this test a regression that dropped/inverted/
        // hardcoded rejectUnauthorized would ship with full green CI.
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"ok":true}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(true); // the secure default
            await assert.rejects(
                client('GET', `https://127.0.0.1:${port}/api`, {}),
                /self.signed certificate|unable to verify|certificate/i,
            );
            // The zero-arg default must behave identically to the explicit `true`.
            const defaultClient = createHttpsClient();
            await assert.rejects(
                defaultClient('GET', `https://127.0.0.1:${port}/api`, {}),
                /self.signed certificate|unable to verify|certificate/i,
            );
        } finally {
            server.close();
        }
    });

    it('rejects a response exceeding the response-size guard instead of buffering it unbounded (#756)', async () => {
        // Ports the boundary test that already covers TerraformInstallerV1's
        // http-client.ts (and PublishKbArticleV1's servicenow-http.ts) to this
        // task's copy of the same MAX_RESPONSE_BYTES guard -- until now neither
        // real task instance (this one nor TerraformDriftReport) had a test
        // proving the guard actually trips against a real streaming response.
        const chunkSize = 1024 * 1024; // 1MiB
        const chunkCount = 11; // 11 MiB total, comfortably over the 10 MiB guard
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            // The client destroys its request once the guard trips, which can
            // surface as a socket-level write error on this side; swallow it so
            // an unhandled 'error' event does not crash the test process.
            res.on('error', () => { /* expected once the client aborts */ });
            res.writeHead(200);
            for (let i = 0; i < chunkCount; i++) {
                res.write(Buffer.alloc(chunkSize, 'a'));
            }
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(false);
            await assert.rejects(
                client('GET', `https://127.0.0.1:${port}/api`, {}),
                /exceeded 10485760 bytes/,
            );
        } finally {
            server.close();
        }
    });

    it('accepts a response at exactly the response-size guard boundary (#756)', async () => {
        const exactly10MiB = 10 * 1024 * 1024;
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.writeHead(200);
            res.end(Buffer.alloc(exactly10MiB, 'a'));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(false);
            const resp = await client('GET', `https://127.0.0.1:${port}/api`, {});
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(resp.body.length, exactly10MiB);
        } finally {
            server.close();
        }
    });

    it('truncates a long response body and passes a short one through', () => {
        assert.strictEqual(truncateBody(''), '');
        assert.strictEqual(truncateBody('short body'), 'short body');
        const long = 'x'.repeat(600);
        const out = truncateBody(long);
        assert.ok(out.length < long.length, 'long body should be truncated');
        assert.ok(out.endsWith('… (truncated)'), 'should mark truncation');
    });

    it('parseJson parses a JSON body but surfaces a non-JSON 2xx body as a truncating error', () => {
        assert.deepStrictEqual(parseJson<{ id: string }>('{"id":"mod-1"}'), { id: 'mod-1' });
        // A captive portal / auth proxy can answer 200 with HTML — must not escape as a raw SyntaxError.
        const html = '<!doctype html><html><body>captive portal login</body></html>';
        assert.throws(
            () => parseJson(html),
            (err: Error) => /non-JSON response body|RegistryNonJsonResponse/.test(err.message) && err.message.includes('captive portal'),
        );
    });
});

describe('http client transport: agent proxy support', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const origGetProxy = t.getHttpProxyConfiguration;

    afterEach(() => {
        t.getHttpProxyConfiguration = origGetProxy;
    });

    it('routes a request through a configured HTTP CONNECT proxy', async () => {
        const target = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"ok":true}');
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = (target.address() as net.AddressInfo).port;

        const { server: proxy, seen } = startConnectProxy();
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;

        t.getHttpProxyConfiguration = () => ({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
            const client = createHttpsClient(false);
            const resp = await client('GET', `https://127.0.0.1:${targetPort}/api`, {});
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(seen.length, 1, 'the proxy should have seen exactly one CONNECT');
            assert.strictEqual(seen[0].target, `127.0.0.1:${targetPort}`);
        } finally {
            target.close();
            proxy.close();
        }
    });

    it('throws a clear error on a malformed proxy URL instead of an unhandled exception', async () => {
        t.getHttpProxyConfiguration = () => ({ proxyUrl: 'not a url' });
        const client = createHttpsClient(false);
        await assert.rejects(
            client('GET', 'https://127.0.0.1:1/api', {}),
            /Invalid proxy URL/,
        );
    });

    it('surfaces a clear error when the proxy refuses the CONNECT tunnel', async () => {
        const proxy = startRefusingConnectProxy(502);
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;
        t.getHttpProxyConfiguration = () => ({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
            const client = createHttpsClient(false);
            await assert.rejects(
                client('GET', 'https://127.0.0.1:1/api', {}),
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
            const client = createHttpsClient(true, 150);
            await assert.rejects(
                client('GET', 'https://127.0.0.1:1/api', {}),
                /timed out after 150ms/,
            );
        } finally {
            proxy.close();
        }
    });
});

describe('retryHttp', () => {
    it('returns a 2xx response without retrying', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 200, body: 'ok' }); }, { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls, 1);
    });

    it('does not retry a 4xx response', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 404, body: '' }); }, { baseDelayMs: 0 });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(calls, 1);
    });

    it('retries a 5xx response and returns the eventual success', async () => {
        const responses: HttpResponse[] = [{ status: 503, body: '' }, { status: 200, body: 'ok' }];
        let i = 0;
        const res = await retryHttp(() => Promise.resolve(responses[i++]), { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(i, 2);
    });

    it('retries a thrown transport error and returns the eventual success', async () => {
        let i = 0;
        const res = await retryHttp(() => {
            i += 1;
            return i === 1 ? Promise.reject(new Error('ECONNRESET')) : Promise.resolve({ status: 200, body: 'ok' });
        }, { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(i, 2);
    });

    it('returns the last 5xx after exhausting retries', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 500, body: '' }); }, { retries: 2, baseDelayMs: 0 });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(calls, 3); // initial attempt + 2 retries
    });

    it('throws the last error after exhausting retries on a persistent transport failure', async () => {
        let calls = 0;
        await assert.rejects(
            () => retryHttp(() => { calls += 1; return Promise.reject(new Error('ETIMEDOUT')); }, { retries: 2, baseDelayMs: 0 }),
            /ETIMEDOUT/,
        );
        assert.strictEqual(calls, 3);
    });

    it('retries a 429 Too Many Requests response and returns the eventual success (#584)', async () => {
        const responses: HttpResponse[] = [{ status: 429, body: '' }, { status: 200, body: 'ok' }];
        let i = 0;
        const res = await retryHttp(() => Promise.resolve(responses[i++]), { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(i, 2, 'a 429 should be retried once here');
    });

    it('returns the last 429 after exhausting retries (#584)', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 429, body: '' }); }, { retries: 2, baseDelayMs: 0 });
        assert.strictEqual(res.status, 429);
        assert.strictEqual(calls, 3); // initial attempt + 2 retries
    });

    it('honors a capped 429 Retry-After header over the default backoff (#633)', async () => {
        // baseDelayMs is deliberately large: if the Retry-After header were NOT
        // honored, the retry would wait the full 5000ms backoff and this
        // assertion would fail on the elapsed-time check below.
        const start = Date.now();
        let calls = 0;
        const res = await retryHttp(() => {
            calls += 1;
            return Promise.resolve({ status: 429, body: '', headers: { 'retry-after': '0' } });
        }, { retries: 1, baseDelayMs: 5000 });
        const elapsed = Date.now() - start;
        assert.strictEqual(res.status, 429);
        assert.strictEqual(calls, 2);
        assert.ok(elapsed < 1000, `expected the Retry-After: 0 header to be honored instead of the 5000ms backoff, took ${elapsed}ms`);
    });

    it('falls back to the default backoff when Retry-After is absent or invalid (#633)', async () => {
        let calls = 0;
        const res = await retryHttp(() => {
            calls += 1;
            return Promise.resolve({ status: 429, body: '', headers: { 'retry-after': 'not-a-valid-value' } });
        }, { retries: 1, baseDelayMs: 5 });
        assert.strictEqual(res.status, 429);
        assert.strictEqual(calls, 2);
    });

    it('does not honor a Retry-After header on a 5xx response (only 429 gets the override) (#633)', async () => {
        // A 5xx is retryable too, but this family only wires Retry-After for 429
        // (matching servicenow-http.ts's withRetry); a 5xx always uses the plain
        // exponential backoff even if the server happened to send the header.
        const start = Date.now();
        let calls = 0;
        const res = await retryHttp(() => {
            calls += 1;
            return Promise.resolve({ status: 503, body: '', headers: { 'retry-after': '0' } });
        }, { retries: 1, baseDelayMs: 50 });
        const elapsed = Date.now() - start;
        assert.strictEqual(res.status, 503);
        assert.strictEqual(calls, 2);
        assert.ok(elapsed >= 40, `expected the default ~50ms backoff to apply to a 5xx despite the Retry-After header, took ${elapsed}ms`);
    });
});

// Direct unit tests for the shared retry.ts module itself (retryAsync +
// parseRetryAfterMs) now live in ./RetryL0, byte-identical across all four
// tasks that carry a copy of retry.ts -- see the import at the top of this
// file.

describe('private-publisher', () => {
    describe('url builders', () => {
        it('builds the module url', () => {
            assert.strictEqual(
                priv.moduleUrl('https://r.example.com', { namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0' }),
                'https://r.example.com/api/v1/modules/aceo/networking-vpc/aws',
            );
        });

        it('strips trailing slashes from the base url', () => {
            assert.strictEqual(
                priv.moduleUrl('https://r.example.com///', { namespace: 'a', name: 'b', provider: 'aws', version: '1.0.0' }),
                'https://r.example.com/api/v1/modules/a/b/aws',
            );
        });

        it('builds the sync url', () => {
            assert.strictEqual(
                priv.syncUrl('https://r.example.com', 'abc-123'),
                'https://r.example.com/api/v1/admin/modules/abc-123/scm/sync',
            );
        });

        it('builds the create and link urls', () => {
            assert.strictEqual(
                priv.createUrl('https://r.example.com///'),
                'https://r.example.com/api/v1/admin/modules/create',
            );
            assert.strictEqual(
                priv.linkUrl('https://r.example.com', 'abc-123'),
                'https://r.example.com/api/v1/admin/modules/abc-123/scm',
            );
        });

        it('throws instead of interpolating a malformed module id into the sync/link urls (#768)', () => {
            assert.throws(() => priv.syncUrl('https://r.example.com', '../admin'), /PrivateModuleIdInvalid/);
            assert.throws(() => priv.linkUrl('https://r.example.com', 'mod-1?x=1'), /PrivateModuleIdInvalid/);
        });

        it('builds the create and link bodies (system = provider; defaults applied)', () => {
            assert.deepStrictEqual(
                JSON.parse(priv.createBody({ namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0' })),
                { namespace: 'aceo', name: 'networking-vpc', system: 'aws' },
            );
            assert.deepStrictEqual(
                JSON.parse(priv.linkBody({
                    namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0',
                    registryUrl: 'https://r.example.com', apiKey: 'k', waitForPublish: false, timeoutSeconds: 5,
                    scmProviderId: 'prov-1', repositoryOwner: 'Terraform', repositoryName: 'terraform-aws-networking-vpc',
                })),
                {
                    provider_id: 'prov-1', repository_owner: 'Terraform', repository_name: 'terraform-aws-networking-vpc',
                    default_branch: 'main', tag_pattern: 'v*',
                },
            );
        });
    });

    describe('isValidModuleId', () => {
        it('accepts existing test-fixture-style ids and UUIDs', () => {
            assert.strictEqual(priv.isValidModuleId('abc-123'), true);
            assert.strictEqual(priv.isValidModuleId('mod-1'), true);
            assert.strictEqual(priv.isValidModuleId('mod-9'), true);
            assert.strictEqual(priv.isValidModuleId('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
        });

        it('rejects path traversal, URL metacharacters, whitespace, and empty/oversized values (#768)', () => {
            assert.strictEqual(priv.isValidModuleId('../admin'), false);
            assert.strictEqual(priv.isValidModuleId('mod-1/../scm'), false);
            assert.strictEqual(priv.isValidModuleId('mod-1?x=1'), false);
            assert.strictEqual(priv.isValidModuleId('mod-1#frag'), false);
            assert.strictEqual(priv.isValidModuleId('mod 1'), false);
            assert.strictEqual(priv.isValidModuleId(''), false);
            assert.strictEqual(priv.isValidModuleId('a'.repeat(129)), false);
        });
    });

    describe('hasVersion', () => {
        it('detects a present version', () => {
            assert.strictEqual(priv.hasVersion('{"versions":[{"version":"1.0.0"},{"version":"1.1.0"}]}', '1.1.0'), true);
        });
        it('returns false when absent or empty', () => {
            assert.strictEqual(priv.hasVersion('{"versions":[]}', '1.0.0'), false);
            assert.strictEqual(priv.hasVersion('{}', '1.0.0'), false);
        });
    });

    describe('publish', () => {
        const opts = {
            namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0',
            registryUrl: 'https://r.example.com', apiKey: 'k', waitForPublish: false, timeoutSeconds: 5,
        };

        it('resolves the module id and triggers a sync', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"id":"mod-1","versions":[]}' },
                { status: 202, body: '' },
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, opts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[1].method, 'POST');
            assert.strictEqual(calls[1].url, 'https://r.example.com/api/v1/admin/modules/mod-1/scm/sync');
        });

        it('throws when the module is not found', async () => {
            const { client } = fakeClient([{ status: 404, body: '{"error":"not found"}' }]);
            await assert.rejects(() => new priv.PrivateRegistryPublisher(client, opts, noop).publish(), /not found in the registry|PrivateModuleNotFoundNoScmInputs/);
        });

        const autoOpts = {
            ...opts,
            scmProviderId: 'prov-1', repositoryOwner: 'Terraform', repositoryName: 'terraform-aws-networking-vpc',
        };

        it('auto-creates and SCM-links a missing module, then syncs', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{"error":"not found"}' }, // GET module
                { status: 201, body: '{"id":"mod-9"}' },         // POST create record
                { status: 201, body: '{"link_id":"lnk-1"}' },    // POST SCM link
                { status: 202, body: '' },                        // POST sync
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 4);
            assert.strictEqual(calls[1].method, 'POST');
            assert.strictEqual(calls[1].url, 'https://r.example.com/api/v1/admin/modules/create');
            assert.deepStrictEqual(JSON.parse(calls[1].body as string), { namespace: 'aceo', name: 'networking-vpc', system: 'aws' });
            assert.strictEqual(calls[2].url, 'https://r.example.com/api/v1/admin/modules/mod-9/scm');
            assert.deepStrictEqual(JSON.parse(calls[2].body as string), {
                provider_id: 'prov-1', repository_owner: 'Terraform', repository_name: 'terraform-aws-networking-vpc',
                default_branch: 'main', tag_pattern: 'v*',
            });
            assert.strictEqual(calls[3].url, 'https://r.example.com/api/v1/admin/modules/mod-9/scm/sync');
        });

        it('tolerates a 409 (already linked) during auto-create and still syncs', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{}' },                        // GET module
                { status: 200, body: '{"id":"mod-9"}' },            // POST create (already exists)
                { status: 409, body: '{"error":"already linked"}' }, // POST SCM link -> tolerated
                { status: 202, body: '' },                           // POST sync
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 4);
            assert.strictEqual(calls[3].url, 'https://r.example.com/api/v1/admin/modules/mod-9/scm/sync');
        });

        it('still throws on 404 when auto-create inputs are incomplete', async () => {
            const partial = { ...opts, scmProviderId: 'prov-1' }; // missing owner + name
            const { client } = fakeClient([{ status: 404, body: '{}' }]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, partial, noop).publish(),
                /not found in the registry|PrivateModuleNotFoundNoScmInputs/,
            );
        });

        it('surfaces a failed create (non-2xx) as an error', async () => {
            const { client } = fakeClient([
                { status: 404, body: '{}' },                     // GET module
                { status: 403, body: '{"error":"forbidden"}' },  // POST create fails (4xx, not retried)
            ]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish(),
                /Failed to create module|PrivateCreateModuleFailed/,
            );
        });

        it('throws when sync is rejected', async () => {
            const { client } = fakeClient([
                { status: 200, body: '{"id":"mod-1"}' },
                { status: 403, body: '{"error":"nope"}' },
            ]);
            await assert.rejects(() => new priv.PrivateRegistryPublisher(client, opts, noop).publish(), /Failed to trigger sync|PrivateTriggerSyncFailed/);
        });

        it('waits for the version to appear when waitForPublish is set', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"id":"mod-1","versions":[]}' },
                { status: 202, body: '' },
                { status: 200, body: '{"id":"mod-1","versions":[{"version":"1.0.0"}]}' },
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, { ...opts, waitForPublish: true }, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 3);
            assert.match(result.message, /available|PrivateVersionAvailable/);
        });

        it('bounds the wait by the deadline and throws on timeout', async () => {
            const { client } = fakeClient([
                { status: 200, body: '{"id":"mod-1","versions":[]}' }, // resolve module
                { status: 202, body: '' },                              // trigger sync
                { status: 200, body: '{"id":"mod-1","versions":[]}' },  // poll: still absent
            ]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, { ...opts, waitForPublish: true, timeoutSeconds: 0 }, noop).publish(),
                /Timed out after 0s|PrivateWaitTimedOut/,
            );
        });

        it('swallows a failing poll and still bounds by the deadline', async () => {
            let n = 0;
            const client: HttpClient = () => {
                n += 1;
                if (n === 1) return Promise.resolve({ status: 200, body: '{"id":"mod-1","versions":[]}' });
                if (n === 2) return Promise.resolve({ status: 202, body: '' });
                return Promise.reject(new Error('ECONNRESET')); // poll fails, must not propagate
            };
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, { ...opts, waitForPublish: true, timeoutSeconds: 0 }, noop).publish(),
                (err: Error) => /Timed out after 0s|PrivateWaitTimedOut/.test(err.message) && !/ECONNRESET/.test(err.message),
            );
        });

        it('rejects a malicious module id returned by the registry before syncing (#768)', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"id":"../../admin/modules/mod-1","versions":[]}' },
            ]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, opts, noop).publish(),
                /PrivateModuleIdInvalid/,
            );
            // Only the GET happened -- the invalid id must never reach a sync/link URL.
            assert.strictEqual(calls.length, 1);
        });

        it('rejects a malicious module id returned by module creation before linking (#768)', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{}' },                            // GET module
                { status: 201, body: '{"id":"mod-9/../../scm?x=1"}' },  // POST create returns a hostile id
            ]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish(),
                /PrivateModuleIdInvalid/,
            );
            assert.strictEqual(calls.length, 2);
        });
    });
});

describe('hcp-publisher', () => {
    const base: hcp.HcpOptions = {
        namespace: 'acme', name: 'vpc', provider: 'aws', version: '1.0.0',
        address: 'https://app.terraform.io', token: 't',
        vcsRepoIdentifier: '', vcsBranch: 'main', vcsOauthTokenId: '', commitSha: 'sha',
        waitForPublish: false, timeoutSeconds: 5,
    };

    describe('url + body builders', () => {
        it('builds the module and versions urls', () => {
            assert.strictEqual(
                hcp.moduleUrl(base),
                'https://app.terraform.io/api/v2/organizations/acme/registry-modules/private/acme/vpc/aws',
            );
            assert.strictEqual(hcp.versionsUrl(base), `${hcp.moduleUrl(base)}/versions`);
            assert.strictEqual(hcp.vcsUrl('https://app.terraform.io', 'acme'), 'https://app.terraform.io/api/v2/organizations/acme/registry-modules/vcs');
        });

        it('reads a version status', () => {
            const body = '{"data":{"attributes":{"version-statuses":[{"version":"1.0.0","status":"ok"}]}}}';
            assert.strictEqual(hcp.versionStatus(body, '1.0.0'), 'ok');
            assert.strictEqual(hcp.versionStatus(body, '9.9.9'), undefined);
            assert.strictEqual(hcp.versionStatus('{}', '1.0.0'), undefined);
        });

        it('builds the version create body', () => {
            assert.strictEqual(
                hcp.versionBody('1.2.3', 'deadbeef'),
                '{"data":{"type":"registry-modules-versions","attributes":{"version":"1.2.3","commit-sha":"deadbeef"}}}',
            );
        });
    });

    describe('publish', () => {
        it('skips when the version is already ok', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"data":{"attributes":{"version-statuses":[{"version":"1.0.0","status":"ok"}]}}}' },
            ]);
            const result = await new hcp.HcpPublisher(client, base, noop).publish();
            assert.strictEqual(result.published, false);
            assert.strictEqual(calls.length, 1);
        });

        it('creates a version when the module exists but the version does not', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"data":{"attributes":{"version-statuses":[]}}}' },
                { status: 201, body: '{}' },
            ]);
            const result = await new hcp.HcpPublisher(client, base, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[1].url, hcp.versionsUrl(base));
        });

        it('creates the VCS module then the version on 404', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{}' },
                { status: 201, body: '{}' },
                { status: 201, body: '{}' },
            ]);
            const opts = { ...base, vcsRepoIdentifier: 'acme/proj/_git/terraform-aws-vpc', vcsOauthTokenId: 'ot-abc' };
            const result = await new hcp.HcpPublisher(client, opts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 3);
            assert.strictEqual(calls[1].url, hcp.vcsUrl(base.address, base.namespace));
        });

        it('retries a transient 5xx on the VCS module create and then succeeds (#427)', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{}' },  // GET module check
                { status: 503, body: '' },    // POST VCS create — transient failure
                { status: 201, body: '{}' },  // POST VCS create — retried, succeeds
                { status: 201, body: '{}' },  // POST version create
            ]);
            const opts = { ...base, vcsRepoIdentifier: 'acme/proj/_git/terraform-aws-vpc', vcsOauthTokenId: 'ot-abc' };
            const result = await new hcp.HcpPublisher(client, opts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 4);
            assert.strictEqual(calls[1].url, hcp.vcsUrl(base.address, base.namespace));
            assert.strictEqual(calls[2].url, hcp.vcsUrl(base.address, base.namespace), 'the VCS create should have been retried after the 503');
        });

        it('throws on 404 when VCS details are missing', async () => {
            const { client } = fakeClient([{ status: 404, body: '{}' }]);
            await assert.rejects(() => new hcp.HcpPublisher(client, base, noop).publish(), /vcsRepoIdentifier|HcpModuleNotFoundNoVcsInputs/);
        });

        it('treats a 422 version response as already-exists', async () => {
            const { client } = fakeClient([
                { status: 200, body: '{"data":{"attributes":{"version-statuses":[]}}}' },
                { status: 422, body: '{}' },
            ]);
            const result = await new hcp.HcpPublisher(client, base, noop).publish();
            assert.strictEqual(result.published, true);
        });

        it('swallows a failing status poll and bounds by the deadline', async () => {
            let n = 0;
            const client: HttpClient = () => {
                n += 1;
                if (n === 1) return Promise.resolve({ status: 200, body: '{"data":{"attributes":{"version-statuses":[]}}}' });
                if (n === 2) return Promise.resolve({ status: 201, body: '{}' });
                return Promise.reject(new Error('ETIMEDOUT')); // poll fails, must not propagate
            };
            await assert.rejects(
                () => new hcp.HcpPublisher(client, { ...base, waitForPublish: true, timeoutSeconds: 0 }, noop).publish(),
                (err: Error) => /Timed out after 0s|HcpWaitTimedOut/.test(err.message) && !/ETIMEDOUT/.test(err.message),
            );
        });
    });
});

// Mock-run tests that actually execute src/index.ts (the orchestrator). The publisher
// modules and the http transport are stubbed in each data file so no real network call
// is made; we assert the credential is masked via setSecret on both routing paths.
describe('index orchestrator (setSecret masking + publisher routing)', () => {
    before(() => {
        // MockTestRunner spawns the data file as a child process; make sure it uses the
        // same node binary running the tests rather than a NODE_OPTIONS-tainted one.
        delete process.env.NODE_OPTIONS;
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    it('masks the apiKey and routes to the private publisher', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishPrivateApiKey.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.indexOf('##vso[task.setsecret]') >= 0,
                'apiKey should be registered as a secret via setSecret',
            );
            // The private publisher mock returns this message; proves the private branch ran.
            assert.ok(
                tr.stdout.indexOf('Sync triggered for version 1.0.0.') >= 0,
                'private publisher branch should have been taken',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('emits the SkipTlsVerifyEnabled warning when skipTlsVerify is true (audit id31/#731)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishSkipTlsVerifyWarning.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            // The mock task-lib environment resolves tasks.loc() to a
            // `loc_mock_<Key>` placeholder rather than the real resource string
            // (no setResourcePath call in this fixture), so assert on the loc key.
            assert.ok(
                tr.warningIssues.some((w) => w.includes('SkipTlsVerifyEnabled')),
                'should have warned that skipTlsVerify is enabled and TLS validation is disabled',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('rejects skipTlsVerify against a known public Terraform registry host (#588)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishSkipTlsVerifyPublicRegistryRejected.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.failed, 'task should have failed');
            assert.ok(
                tr.stdout.includes('SkipTlsVerifyPublicRegistryRejected'),
                'should fail with the public-registry rejection error. stdout: ' + tr.stdout,
            );
            assert.ok(
                !tr.warningIssues.some((w) => w.includes('SkipTlsVerifyEnabled')),
                'must reject BEFORE reaching the skipTlsVerify warning, not warn-then-proceed',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('does not falsely reject a private registry host that merely contains "terraform.io" as a substring (#588 lookalike-safety)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishSkipTlsVerifyLookalikeHostAllowed.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.warningIssues.some((w) => w.includes('SkipTlsVerifyEnabled')),
                'should still warn (legitimate skipTlsVerify usage), not reject',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('rejects skipTlsVerify against the bare apex terraform.io domain, not just subdomains (#588)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishSkipTlsVerifyApexDomainRejected.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.failed, 'task should have failed');
            assert.ok(
                tr.stdout.includes('SkipTlsVerifyPublicRegistryRejected'),
                'should fail with the public-registry rejection error. stdout: ' + tr.stdout,
            );
            assert.ok(
                !tr.warningIssues.some((w) => w.includes('SkipTlsVerifyEnabled')),
                'must reject BEFORE reaching the skipTlsVerify warning, not warn-then-proceed',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('masks the hcpToken and routes to the HCP publisher', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishHcpToken.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.indexOf('##vso[task.setsecret]') >= 0,
                'hcpToken should be registered as a secret via setSecret',
            );
            // The HCP publisher mock returns this message; proves the HCP branch ran.
            assert.ok(
                tr.stdout.indexOf('Version 1.0.0 published to HCP Terraform.') >= 0,
                'HCP publisher branch should have been taken',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('decouples the per-request socket timeout from the user-configurable timeoutSeconds poll deadline', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'SocketTimeoutDecoupledFromPollDeadline.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            const match = tr.stdout.match(/CREATE_HTTPS_CLIENT_ARGS:(\[.*\])/);
            assert.ok(match, 'createHttpsClient should have logged its call args');
            const args = JSON.parse(match![1]);
            // JSON.stringify serializes an `undefined` array element as `null`, so the
            // round-tripped value here is `null`, not `undefined` -- the actual runtime
            // call still passes a true `undefined` (confirmed: createHttpsClient's own
            // `timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS` default parameter only applies
            // when the argument is omitted/undefined, and https-client.ts's tests
            // separately confirm createHttpsClient(true) uses that default).
            assert.strictEqual(
                args[1],
                null,
                `createHttpsClient's socket-timeout arg must not be forwarded from timeoutSeconds (999) -- got ${JSON.stringify(args)}`,
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });
});

describe('index.ts setResourcePath bootstrap (#637)', () => {
    it('resolves real templated messages from task.json once the resource path is set', () => {
        // Mirrors the exact call added to run() in src/index.ts:
        // tasks.setResourcePath(path.join(__dirname, '..', 'task.json')). This
        // must use the REAL azure-pipelines-task-lib/task (as imported at the
        // top of this file), not the mock-run harness used by the
        // "index orchestrator" tests above -- mock-run's TaskMockRunner swaps in
        // mock-task.js, whose loc() unconditionally returns 'loc_mock_<key> ...'
        // regardless of whether setResourcePath was ever called, so it cannot
        // observe this regression at all.
        tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
        assert.strictEqual(tasks.loc('InputRequired', 'name'), "Input 'name' is required.");
        assert.strictEqual(
            tasks.loc('UnsupportedRegistryType', 'bogus'),
            "Unsupported registryType 'bogus'. Expected 'hcp' or 'private'.",
        );
    });
});
