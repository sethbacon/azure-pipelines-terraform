import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Direct unit tests for the reporting helpers (SARIF/JUnit branch coverage).
import './ResultsL0';
// Direct unit tests for sentinel import-name validation (HCL injection guard).
import './SentinelImportNameL0';
// Direct unit tests for sentinel enforcement-level validation (HCL injection guard).
import './SentinelEnforcementLevelL0';
import './HclEscapeL0';
// Direct unit test for the #560 config-dir cleanup-registration reorder.
import './SentinelConfigDirRegistrationL0';
// Direct unit tests for the secure-temp writeSecretFile/replaceSecretFile copy (#607).
import './SecureTempL0';
// Direct unit tests for the bounded engine-output capture guard (#632).
import './OutputCapL0';
// Direct unit tests for the git-clone credential env + redirect scoping (#779).
import './GitAuthEnvL0';
// Direct unit tests for the bounded subprocess execution wrapper (#782).
import './ExecTimeoutL0';
// End-to-end coverage for index.ts's SIGTERM/SIGINT emergency cleanup (#775).
import './SignalHandlerL0';

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

    it('OpaFailNonEmptyScalarDecision — a scalar decision under the default nonEmpty failMode fails loudly instead of passing (audit id19)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'OpaFailNonEmptyScalarDecision.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            const output = tr.errorIssues.join('\n') + '\n' + tr.stdout;
            assert(/does not match the 'nonEmpty' failMode/.test(output), `error should name the failMode mismatch; got: ${output}`);
            assert(/failMode to 'defined'/.test(output), `error should point at the fix; got: ${output}`);
        }, tr);
    });

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

    it('SentinelConfigTempDir — generated config and results land in Agent.TempDirectory', async () => {
        const agentTemp = path.join(os.tmpdir(), 'tpc-sentinel-tempdir', 'agent-temp');
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'SentinelConfigTempDir.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            // The generated sentinel.hcl dir must be created under
            // Agent.TempDirectory (job-end purged), not bare os.tmpdir()
            // (issues #503/#505); the cleanup debug line proves where it lived.
            const configDir = path.join(agentTemp, 'sentinel-config-fixed-tempdir-uuid');
            assert(
                tr.stdout.includes(`Cleaned up temp dir: ${configDir}`),
                `sentinel config dir should be created (and cleaned up) under Agent.TempDirectory; stdout: ${tr.stdout}`,
            );
            // The raw-results file must also land under Agent.TempDirectory
            // (issue #487). It is deliberately NOT deleted at step end — later
            // steps consume it via the resultsFilePath output variable, and the
            // agent purges Agent.TempDirectory when the job finishes.
            const resultsFile = path.join(agentTemp, 'policy-results-fixed-tempdir-uuid.txt');
            assert(fs.existsSync(resultsFile), `results file should exist under Agent.TempDirectory at ${resultsFile}`);
            assert(
                tr.stdout.includes(resultsFile),
                'resultsFilePath output variable should point at the Agent.TempDirectory file',
            );
        }, tr);
    });

    // --- Policy source ---
    expectSuccess('GitSourceClone');
    expectFailure('InsecureGitUrlReject');

    it('GitShaCheckout — SHA checkout succeeds and masks the policy repo token', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'GitShaCheckout.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            // Both the raw token and its derived Basic credential must be
            // registered as secrets so the agent masks them in every log line;
            // guards against accidental removal of the setSecret calls in
            // policy-source.ts (issue #510).
            assert(
                tr.stdout.includes('##vso[task.setsecret]secrettoken'),
                'policyRepoToken should be registered as a secret',
            );
            assert(
                tr.stdout.includes(`##vso[task.setsecret]${Buffer.from(':secrettoken').toString('base64')}`),
                'derived Basic credential should be registered as a secret',
            );
        }, tr);
    });

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
            // The clone dir must be registered for cleanup as soon as its path is
            // computed, before the clone that can throw -- not only after a
            // successful clone -- so a failed clone doesn't leak the temp dir
            // (issue #560). The fixed-uuid clone dir path is reused here so this
            // stays in sync with GitCloneFailure.ts's computation.
            const cloneDir = path.join(os.tmpdir(), 'policy-repo-fixed-clonefail-uuid');
            assert(
                tr.stdout.includes(`Cleaned up temp dir: ${cloneDir}`),
                `clone dir should be registered for cleanup even when the clone itself fails; stdout: ${tr.stdout}`,
            );
        }, tr);
    });

    it('GitCloneCleanupFailureWarns — a cleanup failure on the clone dir surfaces as a warning, not just debug (#766)', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'GitCloneCleanupFailureWarns.js'));
        await tr.runAsync();
        runValidations(() => {
            assert(tr.succeeded, 'the policy check itself should still succeed even though cleanup failed');
            const cloneDir = path.join(os.tmpdir(), 'policy-repo-fixed-cleanupfail-uuid');
            assert(
                tr.warningIssues.some((w) => w.includes(`Failed to clean up ${cloneDir}`)),
                `cleanup failure must be surfaced as a warning; warnings: ${tr.warningIssues}`,
            );
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
