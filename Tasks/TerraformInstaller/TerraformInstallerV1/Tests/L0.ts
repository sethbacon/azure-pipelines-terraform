import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

describe('TerraformInstaller Test Suite', function () {

    before(() => {
        // Prevent VSCode debug path-with-spaces issue when spawning child processes
        delete process.env.NODE_OPTIONS;
        // Use the current Node executable instead of downloading a versioned one
        (ttm.MockTestRunner.prototype as any).getNodePath = function () {
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

    // --- HashiCorp download source ---

    it('hashicorp latest: should resolve version from checkpoint API and download', async () => {
        const tp = path.join(__dirname, 'HashiCorpLatestSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('hashicorp specific version: should skip checkpoint API and download directly', async () => {
        const tp = path.join(__dirname, 'HashiCorpSpecificVersionSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    // --- Cache hit ---

    it('cached install: should use cached tool and skip download', async () => {
        const tp = path.join(__dirname, 'CachedInstallSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    // --- Registry download source ---

    it('registry specific version: should download from pre-signed URL with SHA256 verification', async () => {
        const tp = path.join(__dirname, 'RegistrySpecificVersionSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    // --- Mirror download source ---

    it('mirror custom URL: should download from mirror at HashiCorp path structure', async () => {
        const tp = path.join(__dirname, 'MirrorCustomUrlSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    // --- Failure cases ---

    it('insecure URL: should reject http:// mirror URL', async () => {
        const tp = path.join(__dirname, 'InsecureUrlReject.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('SHA256 mismatch: should fail when downloaded zip hash does not match registry', async () => {
        const tp = path.join(__dirname, 'Sha256VerificationFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('invalid version: should fail when version string is not valid semver', async () => {
        const tp = path.join(__dirname, 'InvalidVersionFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });
});
