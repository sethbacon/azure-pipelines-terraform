import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as https from 'https';
import tasks = require('azure-pipelines-task-lib/task');
import { postJson, postJsonWithRetry, truncateBody } from '../src/callback';
import { createHttpsClient } from '../src/https-client';
import { TLS_CERT, TLS_KEY } from './loopback-tls';
import { startConnectProxy, startRefusingConnectProxy, startHangingConnectProxy } from './proxy-connect-server';

// Direct unit tests for the fail-secure rejectUnauthorized default.
import './RejectUnauthorizedDefaultL0';
// Direct unit tests confirming the https-client destination-host is unrestricted by design (#730).
import './HttpsClientHostHandlingByDesignL0';
// Direct unit tests for the fail-secure failOnCallbackError default.
import './FailOnCallbackErrorDefaultL0';
// Direct unit tests for the secure-temp writeSecretFile/replaceSecretFile copy (#607).
import './SecureTempL0';
// Direct unit tests for the shared retry.ts module (retryAsync + parseRetryAfterMs).
import './RetryL0';

describe('TerraformDriftReport callback transport', function () {
    it('refuses to POST the callback token over a non-HTTPS URL', async () => {
        await assert.rejects(
            postJson('http://insecure.example.com/drift', { 'X-TSM-Callback-Token': 't' }, '{}'),
            /non-HTTPS/,
        );
    });

    it('refuses a non-HTTPS URL even when rejectUnauthorized (TLS verification) is disabled', async () => {
        // The https-only guard must be independent of rejectUnauthorized -- disabling
        // certificate verification must never also disable the https-only requirement.
        await assert.rejects(
            postJson('http://insecure.example.com/drift', { 'X-TSM-Callback-Token': 't' }, '{}', false),
            /non-HTTPS/,
        );
    });

    it('completes a POST and a bodyless GET against a loopback HTTPS server', async () => {
        // Exercises the shared client end-to-end: TLS request, response read
        // (data/end + status), the body-present Content-Length path (POST) and
        // the body-absent path (GET).
        const seen: Array<{ method?: string; body: string }> = [];
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                seen.push({ method: req.method, body });
                res.statusCode = 200;
                res.end('{"ok":true}');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(false); // accept the self-signed cert
            const post = await client('POST', `https://127.0.0.1:${port}/drift`, { 'Content-Type': 'application/json' }, '{"drift":true}');
            assert.strictEqual(post.status, 200);
            assert.strictEqual(post.body, '{"ok":true}');
            const get = await client('GET', `https://127.0.0.1:${port}/health`, {});
            assert.strictEqual(get.status, 200);
            assert.deepStrictEqual(seen.map(s => s.method).sort(), ['GET', 'POST']);
            assert.strictEqual(seen.find(s => s.method === 'POST')!.body, '{"drift":true}');
            assert.strictEqual(seen.find(s => s.method === 'GET')!.body, '');
        } finally {
            server.close();
        }
    });

    it('surfaces response headers (#633) so a 429 Retry-After can reach a caller', async () => {
        // Real end-to-end round-trip against the shared https-client.ts copy
        // (byte-identical with TerraformModulePublish, gated by
        // scripts/check-shared-modules.js): HttpResponse.headers must carry the
        // server's actual response headers. postJsonWithRetry deliberately never
        // consults headers (a received response is never retried -- the one-shot
        // callback token, see callback.ts), so this exercises createHttpsClient
        // directly rather than through postJson/postJsonWithRetry.
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 429;
            res.setHeader('Retry-After', '2');
            res.end('{"error":"slow down"}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(false);
            const resp = await client('GET', `https://127.0.0.1:${port}/drift`, {});
            assert.strictEqual(resp.status, 429);
            assert.strictEqual(resp.headers?.['retry-after'], '2');
        } finally {
            server.close();
        }
    });

    it('rejects a self-signed certificate when rejectUnauthorized is true (the default)', async () => {
        // The secure-default counterpart to the test above: with TLS verification
        // ON (the default), a request against the exact same self-signed loopback
        // server must fail with a certificate-verification error instead of
        // silently succeeding. Every other real-server test in this suite passes
        // rejectUnauthorized=false to make the self-signed cert work, so without
        // this test a regression that dropped/inverted/hardcoded the option would
        // ship with full green CI.
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"ok":true}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(true); // the secure default
            await assert.rejects(
                client('GET', `https://127.0.0.1:${port}/health`, {}),
                /self.signed certificate|unable to verify|certificate/i,
            );
            // The zero-arg default must behave identically to the explicit `true`.
            const defaultClient = createHttpsClient();
            await assert.rejects(
                defaultClient('GET', `https://127.0.0.1:${port}/health`, {}),
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
        // real task instance (this one nor TerraformModulePublish) had a test
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
                client('GET', `https://127.0.0.1:${port}/drift`, {}),
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
            const resp = await client('GET', `https://127.0.0.1:${port}/drift`, {});
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(resp.body.length, exactly10MiB);
        } finally {
            server.close();
        }
    });

    it('times out a hung callback connection instead of hanging', async () => {
        // A bare TCP server that accepts the socket but never completes the TLS
        // handshake — req.setTimeout must fire and reject.
        const server = net.createServer(() => { /* accept and stall */ });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            await assert.rejects(
                postJson(`https://127.0.0.1:${port}/drift`, { 'X-TSM-Callback-Token': 't' }, '{}', true, 150),
                /timed out after 150ms/,
            );
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

    it('postJsonWithRetry retries a bounded number of times on pure transport failures then throws', async () => {
        // A closed port guarantees ECONNREFUSED -- a pure transport failure with
        // no response ever received, the only case this retry policy covers.
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const port = (probe.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const logs: string[] = [];
        await assert.rejects(
            postJsonWithRetry(
                `https://127.0.0.1:${port}/drift`,
                { 'X-TSM-Callback-Token': 't' },
                '{}',
                true,
                undefined,
                { retries: 2, baseDelayMs: 5, log: (m) => logs.push(m) },
            ),
        );
        assert.strictEqual(logs.length, 2, `expected exactly 2 retry attempts logged, got: ${logs.length}`);
    });

    it('postJsonWithRetry does not retry a received 5xx response (one-shot token safety)', async () => {
        let requestCount = 0;
        const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
            requestCount++;
            res.statusCode = 503;
            res.end('{"error":"unavailable"}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const logs: string[] = [];
            const resp = await postJsonWithRetry(
                `https://127.0.0.1:${port}/drift`,
                { 'X-TSM-Callback-Token': 't' },
                '{}',
                false,
                undefined,
                { retries: 2, baseDelayMs: 5, log: (m) => logs.push(m) },
            );
            assert.strictEqual(resp.status, 503);
            assert.strictEqual(requestCount, 1, 'a received 5xx must not be retried (one-shot callback token safety)');
            assert.strictEqual(logs.length, 0, 'no retry should have been logged');
        } finally {
            server.close();
        }
    });
});

describe('https-client: agent proxy support', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const origGetProxy = t.getHttpProxyConfiguration;
    const origSetSecret = t.setSecret;

    afterEach(() => {
        t.getHttpProxyConfiguration = origGetProxy;
        t.setSecret = origSetSecret;
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
            const resp = await client('GET', `https://127.0.0.1:${targetPort}/health`, {});
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(resp.body, '{"ok":true}');
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
            res.end('{"ok":true}');
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
            const client = createHttpsClient(false);
            const resp = await client('GET', `https://127.0.0.1:${targetPort}/health`, {});
            assert.strictEqual(resp.status, 200);
            assert.strictEqual(seen.length, 1);
            assert.strictEqual(seen[0].proxyAuthorization, expectedAuth);
            assert.ok(maskedSecrets.includes('p@ss'), 'the proxy password should be registered as a secret');
            // ADO's masker matches literal registered strings only, so the derived
            // base64 credential must be registered separately from the raw password (#546).
            assert.ok(
                maskedSecrets.includes(Buffer.from('proxyuser:p@ss').toString('base64')),
                'the derived base64 Basic credential should be registered as a secret too',
            );
        } finally {
            target.close();
            proxy.close();
        }
    });

    it('throws a clear error on a malformed proxy URL instead of an unhandled exception', async () => {
        t.getHttpProxyConfiguration = () => ({ proxyUrl: 'not a url' });
        const client = createHttpsClient(false);
        await assert.rejects(
            client('GET', 'https://127.0.0.1:1/health', {}),
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
                client('GET', 'https://127.0.0.1:1/health', {}),
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
            const client = createHttpsClient(false, 150);
            await assert.rejects(
                client('GET', 'https://127.0.0.1:1/health', {}),
                /timed out after 150ms/,
            );
        } finally {
            proxy.close();
        }
    });

    it('connects directly (no proxy) when the agent has none configured', async () => {
        const target = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (_req, res) => {
            res.statusCode = 200;
            res.end('{"ok":true}');
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = (target.address() as net.AddressInfo).port;
        t.getHttpProxyConfiguration = () => undefined;
        try {
            const client = createHttpsClient(false);
            const resp = await client('GET', `https://127.0.0.1:${targetPort}/health`, {});
            assert.strictEqual(resp.status, 200);
        } finally {
            target.close();
        }
    });
});

describe('task.json schema (#643)', () => {
    it('declares the output-variables block with the schema\'s lowercase key', () => {
        // The Azure Pipelines task.json schema (aka.ms/vsts-tasks.schema.json)
        // defines this property as lowercase "outputVariables" -- a capitalized
        // "OutputVariables" is silently ignored by schema-aware tooling (e.g.
        // the classic editor's output-variables picker) even though the task
        // still sets the variables at runtime via the SDK.
        const taskJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'task.json'), 'utf8'));
        assert.ok(Array.isArray(taskJson.outputVariables), 'task.json must declare a lowercase "outputVariables" array');
        assert.strictEqual(taskJson.OutputVariables, undefined, 'the wrong-cased "OutputVariables" key must not reappear');
        const names = taskJson.outputVariables.map((v: { name: string }) => v.name).sort();
        assert.deepStrictEqual(
            names,
            ['addedCount', 'changedCount', 'destroyedCount', 'driftDetected', 'sarifFilePath', 'summaryFilePath'],
        );
    });
});

describe('TerraformDriftReport Test Suite', function () {

    before(() => {
        delete process.env.NODE_OPTIONS;
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    after(() => { });

    function runValidations(validator: () => void, tr: ttm.MockTestRunner) {
        try {
            validator();
        } catch (error) {
            console.log("STDERR", tr.stderr);
            console.log("STDOUT", tr.stdout);
            throw error;
        }
    }

    it('DriftReportBasic — drift reported, succeeds (failOnDrift=false), outputs set', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportBasic.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            // create counts; the read entry is skipped (contract semantics). Matches
            // either the real loc'd text or the mock-test harness's loc_mock_ stub.
            assert(
                /DriftSummary true 1 0 0 1|drifted=true added=1 changed=0 destroyed=0.*1 changed resources/.test(tr.stdout),
                'drift line incorrect',
            );
        }, tr);
    });

    it('DriftReportScrubBeforeUnlink — cleanupSummaryFile scrubs (zeroes) the summary file before unlinking it (#423)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportScrubBeforeUnlink.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.stdout.includes('SCRUB_BEFORE_UNLINK_CHECK zeroed=true markerAbsent=true'),
                `summary file must be scrubbed (zeroed, marker gone) before unlink; stdout: ${tr.stdout}`,
            );
        }, tr);
    });

    it('DriftReportCleanupFailureWarns — a cleanup failure on the summary file surfaces as a warning, not just debug (#423)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCleanupFailureWarns.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'the drift report itself should still succeed even though cleanup failed');
            const summaryFile = path.join(os.tmpdir(), 'tsm-drift-report-fixed-driftreport-cleanupfail-uuid.json');
            assert(
                tr.warningIssues.some((w) => w.includes(`Failed to clean up summary file ${summaryFile}`)),
                `cleanup failure must be surfaced as a warning; warnings: ${tr.warningIssues}`,
            );
        }, tr);
    });

    it('DriftReportFailOnDrift — drift + failOnDrift=true fails the task', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportFailOnDrift.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });


    it('DriftReportClean — no-op only is clean and succeeds even with failOnDrift=true', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportClean.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'clean plan should succeed');
            assert(/DriftSummary false|drifted=false/.test(tr.stdout), 'should report no drift');
        }, tr);
    });

    it('DriftReportMissingFile — missing planJsonFile fails', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportMissingFile.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('DriftReportHugeFile — an oversized plan file fails closed before it is read (#632)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportHugeFile.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(
                tr.errorIssues.some(e =>
                    /PlanFileTooLarge|exceeding the .*-byte guard/.test(e) && e.includes('tdr-huge-plan.json'),
                ),
                `error should name the plan file and the size guard: ${tr.errorIssues}`,
            );
        }, tr);
    });

    it('DriftReportInvalidJson — malformed plan JSON fails with an error naming the plan file (#563)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportInvalidJson.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(
                tr.errorIssues.some(e =>
                    /PlanFileInvalidJson|Failed to parse planJsonFile/.test(e) && e.includes('tdr-invalid-plan.json'),
                ),
                `error should name the plan file: ${tr.errorIssues}`,
            );
        }, tr);
    });

    it('DriftReportSarif — writes a SARIF 2.1.0 report of drifted resources', async () => {
        const sarifPath = path.join(os.tmpdir(), 'tdr-sarif', 'drift.sarif');
        fs.rmSync(sarifPath, { force: true });
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportSarif.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded (failOnDrift=false)');
            assert(fs.existsSync(sarifPath), `SARIF report should exist at ${sarifPath}`);
            const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf-8')) as {
                $schema: string;
                version: string;
                runs: Array<{
                    tool: { driver: { name: string; rules: Array<{ id: string }> } };
                    results: Array<{
                        ruleId: string;
                        level: string;
                        message: { text: string };
                        locations: Array<{ logicalLocations: Array<{ fullyQualifiedName: string }> }>;
                    }>;
                }>;
            };
            assert.strictEqual(sarif.version, '2.1.0', 'SARIF version must be 2.1.0');
            assert(/sarif-2\.1\.0/.test(sarif.$schema), 'SARIF $schema should reference 2.1.0');
            assert.strictEqual(sarif.runs.length, 1, 'exactly one run');
            const run = sarif.runs[0];
            assert.strictEqual(run.tool.driver.name, 'TerraformDriftReport', 'driver name');
            assert.strictEqual(run.results.length, 2, 'one result per drifted resource (read entry skipped)');
            const byAddr = new Map(run.results.map(r => [r.locations[0].logicalLocations[0].fullyQualifiedName, r]));
            assert(byAddr.has('aws_instance.web'), 'update resource present');
            assert(byAddr.has('aws_s3_bucket.gone'), 'delete resource present');
            assert.strictEqual(byAddr.get('aws_instance.web')!.ruleId, 'terraform-drift/update', 'update rule id');
            assert.strictEqual(byAddr.get('aws_s3_bucket.gone')!.ruleId, 'terraform-drift/delete', 'delete rule id');
            run.results.forEach(r => {
                assert.strictEqual(r.level, 'warning', 'drift maps to warning level');
                assert(r.message.text.length > 0, 'message text is set');
                assert(run.tool.driver.rules.some(rule => rule.id === r.ruleId), 'result references a catalogued rule');
            });
        }, tr);
    });

    it('DriftReportCallbackSuccess — 2xx callback succeeds and masks the callback token', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackSuccess.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.stdout.includes('##vso[task.setsecret]super-secret-callback-token'),
                'callback token should be registered as a secret',
            );
            assert(
                /DriftPostedToTsm 200|Drift result posted to TSM \(HTTP 200\)/.test(tr.stdout),
                'should log a successful POST',
            );
        }, tr);
    });

    it('DriftReportCallbackFails — non-2xx callback fails the task', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackFails.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(
                tr.errorIssues.some(e => /DriftCallbackFailed 500|Drift callback failed \(HTTP 500\)/.test(e)),
                'should report the failed callback HTTP status',
            );
        }, tr);
    });

    it('DriftReportCallbackFailNonFatal — failOnCallbackError=false warns instead of failing on a non-2xx callback', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackFailNonFatal.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded (failOnCallbackError=false)');
            assert(
                tr.warningIssues.some(w => /DriftCallbackNonFatal 500|Drift callback failed \(HTTP 500\).*failOnCallbackError/.test(w)),
                'should warn about the non-fatal callback failure',
            );
        }, tr);
    });

    it('DriftReportCallbackPartial — only callbackUrl set warns and skips the callback', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackPartial.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.warningIssues.some(w => /CallbackUrlAndTokenRequired|Both callbackUrl and callbackToken are required/.test(w)),
                'should warn that the callback was skipped',
            );
            assert(
                !/DriftPostedToTsm|Drift result posted to TSM/.test(tr.stdout),
                'callback must not be POSTed when only one of url/token is set',
            );
        }, tr);
    });

    it('DriftReportCallbackTlsOff — rejectUnauthorized=false emits the TLS-off warning', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackTlsOff.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.warningIssues.some(w => /RejectUnauthorizedDisabled|rejectUnauthorized is disabled/.test(w)),
                'should warn that TLS verification is off',
            );
        }, tr);
    });
});
