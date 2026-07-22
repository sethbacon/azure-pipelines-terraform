import * as assert from 'assert';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import * as path from 'path';

// Direct unit tests for the argument builder.
import './ArgsBuilderL0';

describe('TerraformDocs Test Suite', function () {

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
  it('GenerateMarkdownSuccess writes the output file and sets generatedFilePath', async () => {
    const tp = path.join(__dirname, 'GenerateMarkdownSuccess.js');
    const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
    await tr.runAsync();
    runValidations(() => {
      assert(tr.succeeded, 'task should have succeeded');
      assert(tr.errorIssues.length === 0, 'should have no errors. errors: ' + tr.errorIssues);
      assert(
        tr.stdout.includes('##vso[task.setvariable variable=generatedFilePath'),
        'should set the generatedFilePath output variable'
      );
    }, tr);
  });

  expectSuccess('ConsoleOutputSuccess');
  expectSuccess('AdditionalArgsSuccess');

  // Exercises the real fs.statSync wiring in index.ts (the pure unit tests inject
  // a fake stat): an existing config file is forwarded, and the working-directory
  // artifact from an unset optional filePath input is dropped.
  expectSuccess('ConfigFileProvidedSuccess');
  expectSuccess('ConfigFileDirectoryIgnored');

  // --- Failure cases ---
  // --output-check: a stale output file exits non-zero and is reported as OUTDATED...
  it('OutputCheckFail reports stale docs as outdated', async () => {
    const tp = path.join(__dirname, 'OutputCheckFail.js');
    const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
    await tr.runAsync();
    runValidations(() => {
      assert(tr.failed, 'task should have failed');
      assert(tr.errorIssues.length > 0, 'should have an error issue');
      // Mock loc() emits `loc_mock_<KEY> <args...>`, so the KEY proves which branch ran.
      const errors = tr.errorIssues.join('\n');
      assert(/TerraformDocsOutdated/.test(errors), 'stale docs should use the Outdated message, got: ' + errors);
      assert(!/TerraformDocsFailed/.test(errors), 'stale docs must not be reported as a crash, got: ' + errors);
    }, tr);
  });

  // ...but a GENUINE crash under --output-check (no out-of-date signal) must be
  // reported as a failure with the captured detail, NOT mislabeled 'outdated' (#767).
  it('OutputCheckCrash reports the crash, not outdated docs', async () => {
    const tp = path.join(__dirname, 'OutputCheckCrash.js');
    const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
    await tr.runAsync();
    runValidations(() => {
      assert(tr.failed, 'task should have failed');
      assert(tr.errorIssues.length > 0, 'should have an error issue');
      // Mock loc() emits `loc_mock_<KEY> <args...>`: a crash must use the Failed detail
      // message (exit code + captured tool detail), never the Outdated message.
      const errors = tr.errorIssues.join('\n');
      assert(/TerraformDocsFailedDetail 1 /.test(errors), 'a crash should be reported with its exit code, got: ' + errors);
      assert(!/TerraformDocsOutdated/.test(errors), 'a crash must NOT be mislabeled as outdated docs (#767), got: ' + errors);
      assert(/permission denied/i.test(errors), 'the captured tool detail should be folded into the failure, got: ' + errors);
    }, tr);
  });

  // A genuine terraform-docs failure WITHOUT --output-check still folds the captured
  // tool detail into the message (not just an exit code), and never claims 'outdated'.
  it('ExecFailureDetail folds tool detail into a non-check failure', async () => {
    const tp = path.join(__dirname, 'ExecFailureDetail.js');
    const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
    await tr.runAsync();
    runValidations(() => {
      assert(tr.failed, 'task should have failed');
      assert(tr.errorIssues.length > 0, 'should have an error issue');
      const errors = tr.errorIssues.join('\n');
      assert(/TerraformDocsFailedDetail 2 /.test(errors), 'a non-check failure should fold the exit code + detail, got: ' + errors);
      assert(/invalid block definition/i.test(errors), 'the captured tool detail should be folded in, got: ' + errors);
      assert(!/TerraformDocsOutdated/.test(errors), 'a non-check failure must not claim outdated docs, got: ' + errors);
    }, tr);
  });
  expectFailure('UnsupportedFormatterFail');
  expectFailure('ConfigFileNotFoundFail');
});
