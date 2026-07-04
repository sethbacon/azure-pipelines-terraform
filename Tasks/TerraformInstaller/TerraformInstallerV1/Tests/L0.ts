import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

// Direct unit tests for the cosign verifier (certificate-identity anchoring +
// fail-closed behavior). Registered alongside the integration suite below.
import './CosignVerifierL0';
// Direct unit tests for the http-client timeout guard.
import './HttpClientL0';
// Direct unit tests for the optional registry download_url host allowlist.
import './RegistryAllowedHostsL0';

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

    // --- 'latest' checkpoint resolution (#359): a transient failure still falls
    // back, but a malformed API response is now fatal instead of silently
    // downgrading ---

    it('hashicorp latest checkpoint down: falls back to the pinned version with a warning', async () => {
        const tp = path.join(__dirname, 'HashiCorpLatestCheckpointDownFallback.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(
                tr.warningIssues.some((w) => /could not|not found|version/i.test(w)),
                'should warn that the latest version could not be resolved. warnings: ' + tr.warningIssues
            );
        }, tr);
    });

    it('hashicorp latest checkpoint invalid response: fails instead of silently downgrading', async () => {
        const tp = path.join(__dirname, 'HashiCorpLatestCheckpointInvalidResponseFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(tr.errorIssues.length > 0, 'should have an error issue');
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

    // --- Registry pre-signed download-URL token masking (#352) ---
    // The registry download_url carries a live storage credential in its query
    // string and tool-lib logs the URL at INFO. Assert every token component is
    // registered as a secret (so the agent masks it) while benign params stay
    // visible.
    it('registry download token masking: sensitive query params are registered as secrets', async () => {
        const tp = path.join(__dirname, 'RegistryDownloadTokenMasked.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            const maskedTokens = [
                'AWSSIGNATUREtoken1111',   // X-Amz-Signature
                'AWSCREDENTIALtoken2222',  // X-Amz-Credential
                'AWSSECURITYtoken3333',    // X-Amz-Security-Token
                'GOOGSIGNATUREtoken4444',  // X-Goog-Signature
                'GOOGCREDENTIALtoken5555', // X-Goog-Credential
                'AZURESIGtoken6666'        // Azure SAS sig
            ];
            for (const token of maskedTokens) {
                assert(
                    tr.stdout.includes('##vso[task.setsecret]' + token),
                    `expected ##vso[task.setsecret] for token ${token}. stdout: ${tr.stdout}`
                );
            }
            // Benign query parameters must NOT be masked (guards against over-redaction).
            assert(!tr.stdout.includes('##vso[task.setsecret]20260703T000000Z'),
                'benign X-Amz-Date must not be registered as a secret');
            assert(!tr.stdout.includes('##vso[task.setsecret]host'),
                'benign X-Amz-SignedHeaders must not be registered as a secret');
        }, tr);
    });

    it('registry allowed host: should succeed when download_url host matches the allowlist', async () => {
        const tp = path.join(__dirname, 'RegistryAllowedHostAccept.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('registry disallowed host: should reject a download_url host not in the allowlist', async () => {
        const tp = path.join(__dirname, 'RegistryAllowedHostReject.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            // Hostname-matching correctness (exact match / *.suffix wildcard, parsed via
            // new URL().hostname rather than a raw substring check) is proven directly by
            // RegistryAllowedHostsL0's isRegistryHostAllowed unit tests; this only needs
            // to confirm the disallowed-host error path is the one that actually fired.
            assert(
                tr.errorIssues.some(e => e.includes('RegistryDownloadHostNotAllowed')),
                'should fail via the disallowed-host check. errors: ' + tr.errorIssues,
            );
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
