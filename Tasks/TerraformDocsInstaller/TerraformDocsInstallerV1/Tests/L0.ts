import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

// Direct unit tests for the http-client timeout guard.
import './HttpClientL0';
// Direct unit tests for the checksum/platform helpers.
import './InstallerHelpersL0';
// Direct unit tests for the registry download-host allowlist.
import './RegistryAllowedHostsL0';

describe('TerraformDocsInstaller Test Suite', function () {

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

  // --- Success cases ---
  expectSuccess('OfficialSuccess');
  expectSuccess('LatestSuccess');
  expectSuccess('RegistrySuccess');
  expectSuccess('MirrorSuccess');

  it('OfficialChecksumSkip warns when the sha256sum is unavailable', async () => {
    const tp = path.join(__dirname, 'OfficialChecksumSkip.js');
    const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
    await tr.runAsync();
    runValidations(() => {
      assert(tr.succeeded, 'task should have succeeded');
      assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
      assert(tr.stdout.includes('verification skipped'), 'should warn that SHA256 verification was skipped');
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
  // NO stored marker is re-downloaded through the normal verified path and
  // compared against the cached executable — failing closed on a mismatch, and
  // degrading gracefully (warn + trust the cache) only when the source is
  // unreachable, so offline/air-gapped cache reuse keeps working. ---

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

  it('RegistryEmptySha256Warns', async () => {
    const tp = path.join(__dirname, 'RegistryEmptySha256Warns.js');
    const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
    await tr.runAsync();
    runValidations(() => {
      assert(tr.succeeded, 'task should have succeeded');
      assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
      assert(tr.stdout.includes('skipping local verification'), 'should warn that local verification was skipped');
    }, tr);
  });

  // --- Registry pre-signed download-URL token masking ---
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
        'AWSSIGNATUREtoken1111',
        'AWSCREDENTIALtoken2222',
        'AWSSECURITYtoken3333',
        'GOOGSIGNATUREtoken4444',
        'GOOGCREDENTIALtoken5555',
        'AZURESIGtoken6666',
      ];
      for (const token of maskedTokens) {
        assert(
          tr.stdout.includes('##vso[task.setsecret]' + token),
          `expected ##vso[task.setsecret] for token ${token}. stdout: ${tr.stdout}`,
        );
      }
      assert(!tr.stdout.includes('##vso[task.setsecret]20260703T000000Z'),
        'benign X-Amz-Date must not be registered as a secret');
      assert(!tr.stdout.includes('##vso[task.setsecret]host'),
        'benign X-Amz-SignedHeaders must not be registered as a secret');
    }, tr);
  });

  // --- Failure cases ---
  expectFailure('InsecureUrlReject');
  expectFailure('RegistryInsecureUrl');
  expectFailure('Sha256Fail');
  expectFailure('InvalidVersionFail');
  expectFailure('RegistryEmptySha256RequireChecksum');
  expectFailure('MirrorChecksumFetch5xxFail');
});
