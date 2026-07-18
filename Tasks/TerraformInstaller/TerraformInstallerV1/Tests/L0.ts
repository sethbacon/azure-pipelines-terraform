import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

// Direct unit tests for the cosign verifier (version-bound certificate-identity +
// fail-closed behavior). Registered alongside the integration suite below.
import './CosignVerifierL0';
// Direct unit tests for the GPG signature gate exercising the REAL gpg-verifier
// (real openpgp signatures, wrong-key rejection, HashiCorp trust-root canary) — #497.
import './GpgVerifierL0';
// Direct unit tests for the http-client timeout guard.
import './HttpClientL0';
// Direct unit tests for the shared bounded-backoff retry helper (retry.ts), which
// the http-client withRetry now delegates to (#645).
import './RetryL0';
// Direct unit tests for the checksum/sha256/platform helpers exercising a REAL
// computed digest (verifySha256 against real file bytes and real crypto) (#636).
import './InstallerHelpersL0';
// Direct unit tests for the optional registry download_url host allowlist.
import './RegistryAllowedHostsL0';
// Direct unit tests for the operator-URL userinfo redaction helpers (#586).
import './UrlSecretRedactionL0';

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

    // --- 'latest' checkpoint resolution: fail closed. Both a transient request
    // failure and a malformed API response are now fatal rather than silently
    // downgrading to a hardcoded pinned version (a selective outage of only the
    // version-resolution endpoint must not force a stale/downgraded install). ---

    it('hashicorp latest checkpoint down: fails closed instead of silently downgrading', async () => {
        const tp = path.join(__dirname, 'HashiCorpLatestCheckpointDownFallback.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed closed');
            assert(
                tr.errorIssues.some((e) => /resolve the latest Terraform version/i.test(e)),
                'should fail because the latest version could not be resolved. errors: ' + tr.errorIssues
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

    // --- Cache-hit re-verification (#496): a version cached by a possibly-earlier
    // job is re-verified against a local integrity marker recorded at the original
    // verified download, rather than trusted unconditionally on every cache hit. ---

    it('cache hit verify pass: stored integrity marker matches, proceeds silently', async () => {
        const tp = path.join(__dirname, 'CacheHitVerifyPass.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
        }, tr);
    });

    it('cache hit verify fail: stored integrity marker mismatches, rejects the cached copy', async () => {
        const tp = path.join(__dirname, 'CacheHitVerifyFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(
                tr.errorIssues.some((e) => e.includes('CachedToolVerificationFailed')),
                'should fail via the cache integrity re-verification. errors: ' + tr.errorIssues
            );
        }, tr);
    });

    // --- Cache-hit remote re-verification (#496, second half): a cache hit with
    // NO stored marker (cached before markers existed, or cached by a job with
    // verification disabled) is re-downloaded through the normal verified path
    // and compared against the cached executable — failing closed on a mismatch
    // or a signature/checksum verification failure, and degrading gracefully
    // (warn + trust the cache) only when the source is unreachable, so
    // offline/air-gapped cache reuse keeps working. ---

    it('cache hit, no marker, source unreachable: degrades to trusting the cache with a warning', async () => {
        const tp = path.join(__dirname, 'CacheHitHashUnavailable.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            assert(
                tr.stdout.includes('ReverifyingCachedTool'),
                'should announce the re-verification attempt. stdout: ' + tr.stdout
            );
            assert(
                tr.warningIssues.some((w) => w.includes('CachedToolReverificationUnavailable')),
                'should warn that re-verification material was unavailable. warnings: ' + tr.warningIssues
            );
        }, tr);
    });

    it('cache hit, no marker: re-downloads, matches, writes the integrity marker', async () => {
        const tp = path.join(__dirname, 'CacheHitReverifyPass.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            assert(
                tr.stdout.includes('REVERIFY_DOWNLOAD_CALLED:'),
                'should have re-downloaded the release to re-verify the cache entry. stdout: ' + tr.stdout
            );
            assert(
                tr.stdout.includes('MARKER_WRITTEN:') && tr.stdout.includes('.installer-verified.sha256'),
                'should write the integrity marker after a successful re-verification. stdout: ' + tr.stdout
            );
        }, tr);
    });

    it('cache hit, no marker: cached executable mismatches the verified release, rejects it', async () => {
        const tp = path.join(__dirname, 'CacheHitReverifyMismatch.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed');
            assert(
                tr.errorIssues.some((e) => e.includes('CachedToolReverificationMismatch')),
                'should fail closed via the re-verification mismatch. errors: ' + tr.errorIssues
            );
        }, tr);
    });

    it('cache hit, no marker: re-verification signature failure fails closed (not degraded)', async () => {
        const tp = path.join(__dirname, 'CacheHitReverifyGpgFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed closed');
            assert(
                tr.errorIssues.some((e) => e.includes('GPG signature verification failed')),
                'failure should stem from the signature verification. errors: ' + tr.errorIssues
            );
            assert(
                tr.warningIssues.every((w) => !w.includes('CachedToolReverificationUnavailable')),
                'a verification failure must not be degraded to the availability warning. warnings: ' + tr.warningIssues
            );
        }, tr);
    });

    it('cache hit, no marker, requireChecksum=false: skips remote re-verification', async () => {
        const tp = path.join(__dirname, 'CacheHitReverifySkipped.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded');
            assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
            assert(
                !tr.stdout.includes('DOWNLOAD_ATTEMPTED:'),
                'should not attempt any download when the operator opted out. stdout: ' + tr.stdout
            );
            assert(
                tr.stdout.includes('skipping remote re-verification'),
                'should log a debug note that re-verification was skipped. stdout: ' + tr.stdout
            );
        }, tr);
    });

    // --- Cache-hit re-verification fails closed when required material is WITHHELD
    // by a REACHABLE source (#589), distinct from an unreachable source (which still
    // degrades — see CacheHitHashUnavailable above). Both exercise the real reverify
    // classification (the subject module is not mocked). ---

    it('cache hit, no marker: reachable registry withholds required sha256, fails closed (not degraded)', async () => {
        const tp = path.join(__dirname, 'CacheHitReverifyRegistryWithheld.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed closed');
            assert(
                tr.errorIssues.some((e) => /Checksum verification is required/i.test(e)),
                'failure should stem from the withheld required checksum. errors: ' + tr.errorIssues
            );
            assert(
                tr.warningIssues.every((w) => !w.includes('CachedToolReverificationUnavailable')),
                'a withheld-material policy failure must NOT be degraded to the availability warning. warnings: ' + tr.warningIssues
            );
        }, tr);
    });

    it('cache hit, no marker: reachable mirror withholds required SHA256SUMS, fails closed (not degraded)', async () => {
        const tp = path.join(__dirname, 'CacheHitReverifyMirrorWithheld.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed closed');
            assert(
                tr.errorIssues.some((e) => /Checksum verification is required|SHA256SUMS/i.test(e)),
                'failure should stem from the withheld required SHA256SUMS. errors: ' + tr.errorIssues
            );
            assert(
                tr.warningIssues.every((w) => !w.includes('CachedToolReverificationUnavailable')),
                'a withheld-material policy failure must NOT be degraded to the availability warning. warnings: ' + tr.warningIssues
            );
        }, tr);
    });

    // --- Operator mirror/registry URL userinfo redaction (#586) ---
    it('mirror URL with userinfo: strips credentials from the output variable and masks them', async () => {
        const tp = path.join(__dirname, 'MirrorUserInfoRedacted.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.succeeded, 'task should have succeeded. errors: ' + tr.errorIssues);
            // The credential is registered as a secret so the agent masks it everywhere.
            assert(
                tr.stdout.includes('##vso[task.setsecret]s3cr3t'),
                'the embedded password should be registered as a secret. stdout: ' + tr.stdout
            );
            // The persisted variable must carry the userinfo-stripped URL (a downstream
            // task reads this value directly). If it were NOT stripped, the setvariable
            // value would be mirror:https://user:s3cr3t@... (or masked mirror:https://***@...)
            // and this exact substring would be absent.
            assert(
                tr.stdout.includes('mirror:https://artifacts.example.com/hashicorp/terraform'),
                'terraformDownloadedFrom should store the userinfo-stripped mirror URL. stdout: ' + tr.stdout
            );
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

    it('mirror SHA256SUMS 5xx (not 404): fails closed instead of skipping verification', async () => {
        const tp = path.join(__dirname, 'MirrorChecksumFetch5xxFail.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();

        runValidations(() => {
            assert(tr.failed, 'task should have failed closed on a non-404 checksum fetch error');
            assert(
                tr.errorIssues.some((e) => /503|SHA256SUMS/i.test(e)),
                'failure should stem from the SHA256SUMS fetch error. errors: ' + tr.errorIssues
            );
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
