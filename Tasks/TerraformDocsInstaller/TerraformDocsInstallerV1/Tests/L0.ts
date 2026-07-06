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

  // --- Failure cases ---
  expectFailure('InsecureUrlReject');
  expectFailure('RegistryInsecureUrl');
  expectFailure('Sha256Fail');
  expectFailure('InvalidVersionFail');
  expectFailure('RegistryEmptySha256RequireChecksum');
});
