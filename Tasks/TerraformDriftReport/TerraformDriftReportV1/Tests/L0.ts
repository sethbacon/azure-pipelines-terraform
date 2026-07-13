import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as https from 'https';
import { postJson, postJsonWithRetry, truncateBody } from '../src/callback';
import { createHttpsClient } from '../src/https-client';
import { TLS_CERT, TLS_KEY } from './loopback-tls';

// Direct unit tests for the fail-secure rejectUnauthorized default.
import './RejectUnauthorizedDefaultL0';

describe('TerraformDriftReport callback transport', function () {
    it('refuses to POST the callback token over a non-HTTPS URL', async () => {
        await assert.rejects(
            postJson('http://insecure.example.com/drift', { 'X-TSM-Callback-Token': 't' }, '{}'),
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
            // create counts; the read entry is skipped (contract semantics).
            assert(tr.stdout.includes('drifted=true added=1 changed=0 destroyed=0'), 'drift line incorrect');
            assert(tr.stdout.includes('1 changed resources'), 'read entry should be skipped from the summary');
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
            assert(tr.stdout.includes('drifted=false'), 'should report no drift');
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
            assert(tr.stdout.includes('Drift result posted to TSM (HTTP 200).'), 'should log a successful POST');
        }, tr);
    });

    it('DriftReportCallbackFails — non-2xx callback fails the task', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackFails.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(
                tr.errorIssues.some(e => e.includes('Drift callback failed (HTTP 500)')),
                'should report the failed callback HTTP status',
            );
        }, tr);
    });

    it('DriftReportCallbackPartial — only callbackUrl set warns and skips the callback', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportCallbackPartial.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.warningIssues.some(w => w.includes('Both callbackUrl and callbackToken are required')),
                'should warn that the callback was skipped',
            );
            assert(
                !tr.stdout.includes('Drift result posted to TSM'),
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
                tr.warningIssues.some(w => w.includes('rejectUnauthorized is disabled')),
                'should warn that TLS verification is off',
            );
        }, tr);
    });
});
