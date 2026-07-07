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
  expectFailure('OutputCheckFail');
  expectFailure('UnsupportedFormatterFail');
  expectFailure('ConfigFileNotFoundFail');
});
