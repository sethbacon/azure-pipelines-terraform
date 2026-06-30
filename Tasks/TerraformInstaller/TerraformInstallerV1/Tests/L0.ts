import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

// Direct unit tests for the cosign verifier (certificate-identity anchoring +
// fail-closed behavior). Registered alongside the integration suite below.
import './CosignVerifierL0';
// Direct unit tests for the http-client timeout guard.
import './HttpClientL0';

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

    it('path prepended: installed terraform directory is added to PATH', async () => {
        const tp = path.join(__dirname, 'PathPrependedOnInstall.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.stdout.includes('PREPEND_PATH_CALLED:/tmp/terraform-cached'),
                'installed terraform directory should be prepended to PATH so PipelineTerraformTask can find it via tasks.which()',
            );
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

    it('registry insecure download_url: should reject a non-https pre-signed URL', async () => {
        const tp = path.join(__dirname, 'RegistryInsecureUrlReject.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('registry empty sha256 + requireChecksum: should fail closed', async () => {
        const tp = path.join(__dirname, 'RegistryEmptySha256RequireChecksum.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('registry empty sha256 (not required): should succeed with a skip warning', async () => {
        const tp = path.join(__dirname, 'RegistryEmptySha256Warns.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            assert(tr.stdout.includes('skipping local verification'), 'should warn that local verification was skipped');
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

    // --- GPG signature verification ---

    it('GPG verification success: should pass when GPG signature is valid', async () => {
        const tp = path.join(__dirname, 'GpgVerificationSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('GPG verification failure: should fail when GPG signature is invalid', async () => {
        const tp = path.join(__dirname, 'GpgVerificationFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    it('GPG signature unavailable: should succeed with warning when .sig file is missing', async () => {
        const tp = path.join(__dirname, 'GpgSignatureUnavailable.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('GPG signature required but missing: should fail when requireGpgSignature is true', async () => {
        const tp = path.join(__dirname, 'GpgSignatureRequiredButMissing.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
        }, tr);
    });

    // --- OpenTofu download ---

    it('opentofu latest: should resolve version from GitHub API and download', async () => {
        const tp = path.join(__dirname, 'OpenTofuLatestSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('opentofu specific version: should skip GitHub API and download directly', async () => {
        const tp = path.join(__dirname, 'OpenTofuSpecificVersionSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('opentofu cached: should use cached tool and skip download', async () => {
        const tp = path.join(__dirname, 'OpenTofuCachedSuccess.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('opentofu path prepended: installed tofu directory is added to PATH', async () => {
        const tp = path.join(__dirname, 'TofuPathPrependedOnInstall.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.stdout.includes('PREPEND_PATH_CALLED:/tmp/tofu-cached'),
                'installed tofu directory should be prepended to PATH so PipelineTerraformTask can find it via tasks.which()',
            );
        }, tr);
    });
});
