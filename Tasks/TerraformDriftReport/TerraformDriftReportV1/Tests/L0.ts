import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as https from 'https';
import tasks = require('azure-pipelines-task-lib/task');
import { summarize } from '@4cloudguru/terraform-drift-contract';
import { postJson, postJsonWithRetry, truncateBody } from '../src/callback';
import { createHttpsClient } from '../src/https-client';
import { TLS_CERT, TLS_KEY } from './loopback-tls';
import { startConnectProxy, startRefusingConnectProxy, startHangingConnectProxy } from './proxy-connect-server';
import {
    CONTROL_CHARS_ADDRESS,
    ANSI_ESCAPE_ADDRESS,
    SCRIPT_MARKUP_ADDRESS,
    QUOTES_BACKSLASH_ADDRESS,
    LONG_ADDRESS,
    DIRECTION_OVERRIDE_ADDRESS,
    HOSTILE_ATTR_NAME,
    HOSTILE_ATTR_ADDRESS,
} from './sarif-hostile-fixtures';

// Direct unit tests for the fail-secure rejectUnauthorized default.
import './RejectUnauthorizedDefaultL0';
// Direct unit tests confirming the https-client destination-host is unrestricted by design (#730).
import './HttpsClientHostHandlingByDesignL0';
// Direct unit tests for the fail-secure failOnCallbackError default.
import './FailOnCallbackErrorDefaultL0';
// Direct unit tests for the shared secure-temp writers (#607).
import './SecureTempL0';
// Direct unit tests for the shared retry.ts module (retryAsync + parseRetryAfterMs).
import './RetryL0';
// End-to-end coverage for index.ts's SIGTERM/SIGINT emergency summary-file scrub (#775).
import './SignalHandlerL0';

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

    it('DriftReportSarifHostile — hostile resource addresses/attribute names survive the real SARIF path as safely-escaped JSON data, not raw control bytes or broken structure (#898)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportSarifHostile.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded (failOnDrift=false)');

            // No fixed sarifPath input was given -- recover the auto-generated,
            // uuid-named path the task actually wrote from its own output-variable
            // logging command rather than assuming any particular location.
            const varLine = tr.stdout.split('\n').find(l => l.includes('##vso[task.setvariable variable=sarifFilePath;'));
            assert(varLine, `sarifFilePath output variable line not found in stdout: ${tr.stdout}`);
            const sarifPath = varLine!.slice(varLine!.indexOf(']') + 1).trim();
            assert(fs.existsSync(sarifPath), `SARIF report should exist at ${sarifPath}`);

            const raw = fs.readFileSync(sarifPath, 'utf-8');

            // The control characters/ANSI escape must appear only as their escaped
            // JSON forms (\u0000, \u001b, ...) -- never as a literal raw control
            // byte -- proving JSON.stringify (not manual concatenation) serialized
            // them. \x09/\x0A/\x0D are excluded: those are the file's own legitimate
            // pretty-printing whitespace, not hostile content under test here.
            assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(raw), 'raw SARIF file must not contain a literal unescaped control byte');
            assert(raw.includes('\\u0000'), 'NUL must survive as an escaped \\u0000 sequence');
            assert(raw.toLowerCase().includes('\\u001b'), 'the ANSI ESC byte must survive as an escaped \\u001b sequence');

            // Must still be valid JSON that round-trips (a broken/truncated
            // structure would throw here or fail the re-stringify comparison).
            const sarif = JSON.parse(raw) as {
                version: string;
                runs: Array<{
                    results: Array<{
                        message: { text: string };
                        locations: Array<{ logicalLocations: Array<{ fullyQualifiedName: string }> }>;
                    }>;
                }>;
            };
            assert.strictEqual(
                JSON.stringify(JSON.parse(JSON.stringify(sarif))),
                JSON.stringify(sarif),
                'SARIF must round-trip through JSON unchanged',
            );
            assert.strictEqual(sarif.version, '2.1.0', 'SARIF version must be 2.1.0');

            const run = sarif.runs[0];
            assert.strictEqual(run.results.length, 7, 'one result per hostile resource change');
            const byAddr = new Map(run.results.map(r => [r.locations[0].logicalLocations[0].fullyQualifiedName, r]));

            // Every hostile address must be preserved EXACTLY as data -- no
            // truncation, no mangling -- proving it never escaped its JSON string.
            for (const addr of [
                CONTROL_CHARS_ADDRESS,
                ANSI_ESCAPE_ADDRESS,
                SCRIPT_MARKUP_ADDRESS,
                QUOTES_BACKSLASH_ADDRESS,
                LONG_ADDRESS,
                DIRECTION_OVERRIDE_ADDRESS,
                HOSTILE_ATTR_ADDRESS,
            ]) {
                assert(byAddr.has(addr), `expected a result for hostile address (len ${addr.length})`);
            }
            assert.strictEqual(
                byAddr.get(LONG_ADDRESS)!.locations[0].logicalLocations[0].fullyQualifiedName.length,
                LONG_ADDRESS.length,
                'the very long address must not be truncated',
            );

            // The hostile attribute name must be carried through message.text as data too.
            const hostileAttrResult = byAddr.get(HOSTILE_ATTR_ADDRESS)!;
            assert(
                hostileAttrResult.message.text.includes(HOSTILE_ATTR_NAME),
                'hostile attribute name must appear verbatim in the message text',
            );
        }, tr);
    });

    it('DriftReportSensitiveMasking — an attribute marked on ONE mirror is masked on BOTH sides, and module provenance is projected, in what the task writes', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportSensitiveMasking.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded (failOnDrift=false)');

            // Recover both uuid-named artifacts from the task's own output-variable
            // logging commands (same technique as DriftReportSarifHostile) rather
            // than assuming a location.
            const outputVar = (name: string): string => {
                const line = tr.stdout.split('\n').find(l => l.includes(`##vso[task.setvariable variable=${name};`));
                assert(line, `${name} output variable line not found in stdout: ${tr.stdout}`);
                return line!.slice(line!.indexOf(']') + 1).trim();
            };
            const summaryPath = outputVar('summaryFilePath');
            const sarifPath = outputVar('sarifFilePath');
            assert(fs.existsSync(summaryPath), `summary file should exist at ${summaryPath}`);
            const raw = fs.readFileSync(summaryPath, 'utf-8');
            const body = JSON.parse(raw) as {
                summary: Array<{ address: string; attrs?: Array<{ name: string; before: string | null; after: string | null }> }>;
                plan: { configuration: { root_module: { module_calls: Record<string, Record<string, string>> } } };
            };

            // Marked on `after` only -- `before` must NOT be the cleartext value.
            const web = body.summary.find(e => e.address === 'aws_instance.web');
            assert(web, 'aws_instance.web must be in the summary');
            assert.deepStrictEqual(
                web!.attrs,
                [{ name: 'user_data', before: '(sensitive)', after: '(sensitive)' }],
                'an after-only sensitivity mark must mask BOTH sides',
            );

            // The mirror image: marked on `before` only.
            const legacy = body.summary.find(e => e.address === 'aws_db_instance.legacy');
            assert(legacy, 'aws_db_instance.legacy must be in the summary');
            assert.deepStrictEqual(
                legacy!.attrs,
                [{ name: 'password', before: '(sensitive)', after: '(sensitive)' }],
                'a before-only sensitivity mark must mask BOTH sides',
            );

            // Module provenance is projected to the two fields the backend reads,
            // with the module source's embedded credential scrubbed -- the raw
            // config subtree (which carries no sensitivity metadata to mask
            // against) must not be relayed.
            assert.deepStrictEqual(
                body.plan.configuration.root_module.module_calls,
                {
                    vpc: {
                        source: 'git::https://(redacted)@github.com/org/mod.git',
                        version_constraint: '~> 5.0',
                    },
                },
                'module provenance must be the two-field projection, not the raw subtree',
            );

            // Tripwire: none of the fixture's known-secret literals may appear in
            // ANY plan-derived artifact this task writes, nor in the build log.
            // (The SARIF report names changed attributes but never their values,
            // so it is asserted here as a standing no-leak guarantee.)
            assert(fs.existsSync(sarifPath), `SARIF report should exist at ${sarifPath}`);
            const sarifRaw = fs.readFileSync(sarifPath, 'utf-8');
            for (const secret of [
                'BEFORE-ONLY-PLAINTEXT-SECRET',
                'AFTER-ONLY-PLAINTEXT-SECRET',
                'BEFORE-VALUE-MARKED-SENSITIVE',
                'AFTER-VALUE-MARKED-SENSITIVE',
                'CONFIG-EMBEDDED-PASSWORD',
                'ghp_MODULESOURCETOKEN',
                'aws_db_instance.inner',
            ]) {
                assert(!raw.includes(secret), `summary file must not contain ${secret}`);
                assert(!sarifRaw.includes(secret), `SARIF report must not contain ${secret}`);
                assert(!tr.stdout.includes(secret), `build log must not contain ${secret}`);
            }
        }, tr);
    });

    it('DriftReportModuleManifestTraversalSkipped — a moduleManifest resolving outside the working directory omits module_locks (#1031)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportModuleManifestTraversalSkipped.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'the drift report itself should still succeed');
            assert(
                tr.warningIssues.some((w) => w.includes('resolves outside the working directory')),
                `should warn that moduleManifest escapes the working directory. warnings: ${tr.warningIssues}`,
            );
            const line = tr.stdout.split('\n').find(l => l.includes('##vso[task.setvariable variable=summaryFilePath;'));
            assert(line, `summaryFilePath output variable line not found in stdout: ${tr.stdout}`);
            const summaryPath = line!.slice(line!.indexOf(']') + 1).trim();
            const body = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
            assert.strictEqual(body.module_locks, null, 'module_locks must be omitted, not read from outside the working directory');
        }, tr);
    });

    it('DriftReportModuleManifestSymlinkSkipped — a moduleManifest that only stays inside the working directory lexically, via a symlink, omits module_locks (#1031)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportModuleManifestSymlinkSkipped.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'the drift report itself should still succeed');
            assert(
                tr.warningIssues.some((w) => w.includes('resolves outside the working directory')),
                `should warn that moduleManifest escapes the working directory. warnings: ${tr.warningIssues}`,
            );
            const line = tr.stdout.split('\n').find(l => l.includes('##vso[task.setvariable variable=summaryFilePath;'));
            assert(line, `summaryFilePath output variable line not found in stdout: ${tr.stdout}`);
            const summaryPath = line!.slice(line!.indexOf(']') + 1).trim();
            const body = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
            assert.strictEqual(body.module_locks, null, 'module_locks must be omitted, not read through a symlink escaping the working directory');
            assert(!tr.stdout.includes('leaked'), 'the out-of-bounds manifest content must never reach the log');
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

// #950 — the completeness markers: what the check did NOT do.
//
// The callback body was assembled by naming the contract's fields one at a time
// into a `Record<string, unknown>`. Contract 1.2.0 added five markers and every
// one was dropped, invisibly: a pick list cannot report a field it never
// mentions, and the destination type accepted anything, so `tsc` had nothing to
// say either. The result was that a plan this task could not read left the agent
// as `drifted: false` with zero counts -- byte-identical to a verified-clean run
// -- and TSM auto-resolved the live drift record on it.
//
// Every case asserts BOTH directions. A body that hardcoded `unparseable: false`
// passes any test that only ever feeds it a readable plan, and one that
// hardcoded `true` passes any test that only feeds it a broken one; only the
// pair distinguishes a forwarded value from a constant.
describe('TerraformDriftReport completeness markers (#950)', function () {
    this.timeout(30000);

    const MARKERS = ['unparseable', 'unmasked', 'truncated', 'omitted_entries', 'omitted_attrs'] as const;

    interface Posted extends Record<string, unknown> {
        added: number;
        changed: number;
        destroyed: number;
        drifted: boolean;
        summary: unknown[];
    }

    // Runs the shared fixture for one case and returns BOTH the bytes it would
    // have POSTed and the summary artifact it wrote. The two are the same object
    // in src/index.ts, and #950 dropped the markers from both; asserting only one
    // would pass on a refactor that split them.
    async function runCase(name: string): Promise<{ posted: Posted; artifact: Posted; tr: ttm.MockTestRunner }> {
        const postedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-posted-')), 'posted.json');
        process.env['TDR_MARKER_CASE'] = name;
        process.env['TDR_MARKER_POSTED'] = postedFile;
        try {
            const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCompletenessMarkers.js'));
            await tr.runAsync();
            assert(tr.succeeded, `task should have succeeded for case ${name}: ${tr.stdout}\n${tr.stderr}`);
            assert(fs.existsSync(postedFile), `no callback body was captured for case ${name}: ${tr.stdout}`);
            const posted = JSON.parse(fs.readFileSync(postedFile, 'utf-8')) as Posted;

            const line = tr.stdout.split('\n').find(l => l.includes('##vso[task.setvariable variable=summaryFilePath;'));
            assert(line, `summaryFilePath output variable not found: ${tr.stdout}`);
            const artifactPath = line!.slice(line!.indexOf(']') + 1).trim();
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Posted;
            return { posted, artifact, tr };
        } finally {
            delete process.env['TDR_MARKER_CASE'];
            delete process.env['TDR_MARKER_POSTED'];
        }
    }

    // The load-bearing one. This body is 0/0/0 + drifted:false -- identical to
    // the clean case below on every other field. `unparseable` is the only thing
    // separating "we checked and it was clean" from "we never finished
    // checking", and the receiver resolved the record on both until it arrived.
    it('an unreadable document is POSTed as unparseable, not as clean', async () => {
        const { posted, artifact } = await runCase('unreadable');
        assert.strictEqual(posted.unparseable, true, 'unparseable must travel');
        assert.deepStrictEqual(
            [posted.added, posted.changed, posted.destroyed, posted.drifted],
            [0, 0, 0, false],
            'an unreadable document is otherwise indistinguishable from a clean one',
        );
        assert.strictEqual(artifact.unparseable, true, 'the on-agent summary artifact must carry it too');
    });

    // Positive control. A hardcoded `unparseable: true` satisfies the assertion
    // above; only a run where the value is genuinely false proves the marker is
    // forwarded rather than pinned.
    it('a genuinely clean plan is POSTed as parseable (positive control)', async () => {
        const { posted, artifact } = await runCase('clean');
        assert.strictEqual(posted.unparseable, false);
        assert.strictEqual(artifact.unparseable, false);
        assert.deepStrictEqual([posted.added, posted.changed, posted.destroyed, posted.drifted], [0, 0, 0, false]);
    });

    it('a change carrying no sensitivity metadata sets unmasked', async () => {
        const { posted } = await runCase('unmasked');
        assert.strictEqual(posted.unmasked, true);
    });

    it('a change carrying sensitivity mirrors does not (positive control)', async () => {
        const { posted } = await runCase('masked');
        assert.strictEqual(posted.unmasked, false);
    });

    it('a capped summary POSTs truncated and how many rows were dropped', async () => {
        const { posted } = await runCase('cappedEntries');
        assert.strictEqual(posted.truncated, true);
        assert.strictEqual(posted.omitted_entries, 3);
        // The counts are NOT capped, so `drifted` stays truthful while the list
        // is partial. That discrepancy is only legible because the marker rides
        // along with it.
        assert.strictEqual(posted.added, 503, 'counts must not be capped');
        assert.strictEqual(posted.summary.length, 500, 'the summary is capped at the contract bound');
    });

    it('a capped attribute list POSTs how many attrs were dropped', async () => {
        const { posted } = await runCase('cappedAttrs');
        assert.strictEqual(posted.truncated, true);
        assert.strictEqual(posted.omitted_attrs, 4);
    });

    it('an uncapped report says so rather than staying silent (positive control)', async () => {
        const { posted } = await runCase('unmasked');
        assert.strictEqual(posted.truncated, false);
        assert.strictEqual(posted.omitted_entries, 0);
        assert.strictEqual(posted.omitted_attrs, 0);
    });

    // The class guard, and the reason the body is a spread rather than a pick
    // list: this fails on the NEXT field the contract adds, not just on the five
    // dropped this time. It re-derives the expectation from the resolved package,
    // so a contract bump that widens Result reddens here -- in the producer that
    // emits the payload -- instead of arriving at TSM as a silent omission.
    it('every field the contract computes is forwarded, with the contract-computed value', async () => {
        const { posted } = await runCase('cappedEntries');
        const computed = summarize({
            resource_changes: Array.from({ length: 503 }, (_unused, i) => ({
                address: `aws_s3_bucket.b${i}`,
                change: { actions: ['create'], before: null, after: {} },
            })),
        }) as unknown as Record<string, unknown>;

        const dropped = Object.keys(computed).filter(k => !(k in posted));
        assert.deepStrictEqual(dropped, [], `the callback body drops contract fields: ${dropped.join(', ')}`);
        for (const marker of MARKERS) {
            assert.deepStrictEqual(
                posted[marker],
                computed[marker],
                `${marker} is not the contract-computed value (a constant would pass a one-sided test)`,
            );
        }
    });

    // The names are not this task's to choose. TSM decodes them as the json tags
    // of `completeness` in internal/api/drift_records.go, and its own generated
    // jq templates already post exactly these keys. Because that callback
    // deliberately does not use DisallowUnknownFields -- its token is one-shot,
    // so a rejected body would strand the run -- a renamed marker is dropped in
    // silence rather than reported.
    it('uses the snake_case wire names the receiver decodes', async () => {
        const { posted } = await runCase('unmasked');
        for (const marker of MARKERS) {
            assert(marker in posted, `the callback body must carry ${marker}; got ${Object.keys(posted).join(', ')}`);
        }
    });
});
