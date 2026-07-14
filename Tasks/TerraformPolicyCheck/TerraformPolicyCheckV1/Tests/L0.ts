import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Direct unit tests for the reporting helpers (SARIF/JUnit branch coverage).
import './ResultsL0';
// Direct unit tests for sentinel import-name validation (HCL injection guard).
import './SentinelImportNameL0';
import './HclEscapeL0';

describe('TerraformPolicyCheck Test Suite', function () {

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

    function expectSuccess(file: string) {
        it(file, async () => {
            const tp = path.join(__dirname, `${file}.js`);
            const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
            await tr.runAsync();
            runValidations(() => {
                assert(tr.succeeded, 'task should have succeeded');
                assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            }, tr);
        });
    }

    function expectFailure(file: string) {
        it(file, async () => {
            const tp = path.join(__dirname, `${file}.js`);
            const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
            await tr.runAsync();
            runValidations(() => {
                assert(tr.failed, 'task should have failed');
                assert(tr.errorIssues.length > 0, 'should have an error issue');
            }, tr);
        });
    }

    // --- OPA engine ---
    expectSuccess('OpaPassPath');
    expectFailure('OpaFailPath');
    expectFailure('OpaFailDefined');

    it('OpaExecError — non-zero opa exit surfaces stderr and the exit code', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'OpaExecError.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            const output = tr.errorIssues.join('\n') + '\n' + tr.stdout;
            assert(/'opa exec' failed \(exit code 1\)/.test(output), `error should name the exit code; got: ${output}`);
            assert(/rego_parse_error/.test(output), 'error should include the stderr diagnostic');
        }, tr);
    });

    // --- Sentinel engine (enforcement levels) ---
    expectSuccess('SentinelPassPath');
    expectFailure('SentinelHardFail');
    expectSuccess('SentinelAdvisoryWarn');
    expectSuccess('SentinelSoftOverride');
    expectFailure('SentinelUnrecognizedExitFail');

    // --- Policy source ---
    expectSuccess('GitSourceClone');
    expectSuccess('GitShaCheckout');
    expectFailure('InsecureGitUrlReject');

    it('GitRefInjectionReject — a leading-dash ref is rejected before git runs', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'GitRefInjectionReject.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            const output = tr.errorIssues.join('\n') + '\n' + tr.stdout;
            assert(/loc_mock_InvalidPolicyRepoRef/.test(output), `ref should be rejected; got: ${output}`);
        }, tr);
    });

    it('SubdirTraversalReject — a `../` subdir escaping the clone dir is rejected', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'SubdirTraversalReject.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            const output = tr.errorIssues.join('\n') + '\n' + tr.stdout;
            assert(/loc_mock_PolicySubdirOutsideRepo/.test(output), `subdir should be rejected; got: ${output}`);
        }, tr);
    });

    it('GitCloneFailure — a non-zero git clone surfaces as a task failure', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'GitCloneFailure.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('MissingSubdir — an absent subdir in the clone surfaces a clear error', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'MissingSubdir.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            const output = tr.errorIssues.join('\n') + '\n' + tr.stdout;
            assert(/Policy subdirectory does not exist in the cloned repo/.test(output), `should report missing subdir; got: ${output}`);
        }, tr);
    });

    // --- Results publishing ---
    expectSuccess('PublishResults');

    // --- SARIF output ---
    it('OpaSarifOutput — writes a SARIF 2.1.0 report of violations', async () => {
        const sarifPath = path.join(os.tmpdir(), 'tpc-sarif', 'policy.sarif');
        fs.rmSync(sarifPath, { force: true });
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'OpaSarifOutput.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed (policy violations)');
            assert(fs.existsSync(sarifPath), `SARIF report should exist at ${sarifPath}`);
            const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf-8')) as {
                $schema: string;
                version: string;
                runs: Array<{
                    tool: { driver: { name: string; rules: Array<{ id: string }> } };
                    results: Array<{ ruleId: string; ruleIndex: number; level: string; message: { text: string } }>;
                }>;
            };
            assert.strictEqual(sarif.version, '2.1.0', 'SARIF version must be 2.1.0');
            assert(/sarif-2\.1\.0/.test(sarif.$schema), 'SARIF $schema should reference 2.1.0');
            assert.strictEqual(sarif.runs.length, 1, 'exactly one run');
            const run = sarif.runs[0];
            assert.strictEqual(run.tool.driver.name, 'TerraformPolicyCheck', 'driver name');
            assert.strictEqual(run.results.length, 2, 'one result per violation');
            run.results.forEach(r => {
                assert.strictEqual(r.level, 'error', 'OPA violations map to error level');
                assert(r.ruleId.length > 0, 'ruleId is set');
                assert(r.message.text.length > 0, 'message text is set');
                assert(run.tool.driver.rules.some(rule => rule.id === r.ruleId), 'result references a catalogued rule');
            });
            const messages = run.results.map(r => r.message.text);
            assert(messages.includes('S3 bucket must not be public'), 'violation message preserved verbatim');
        }, tr);
    });
});
