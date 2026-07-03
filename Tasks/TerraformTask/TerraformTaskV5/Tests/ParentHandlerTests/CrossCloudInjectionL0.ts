import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { ParentCommandHandler, STATE_COMMANDS } from '../../src/parent-handler';
import { EnvironmentVariableHelper } from '../../src/environment-variables';

/**
 * Direct unit tests for ParentCommandHandler's cross-cloud backend credential
 * injection decision logic. `tasks.getInput` is mocked by function
 * reassignment (as the other direct-style tests in this suite do) rather than
 * via raw `process.env['INPUT_*']` values: the real azure-pipelines-task-lib
 * reads inputs from an in-memory vault that is populated once per process
 * from `process.env` and then has those variables deleted — only
 * TaskMockRunner's full sandbox (which swaps in a separate mock-task module)
 * makes plain env vars work, so a direct-style test must mock the function
 * itself. The full success path (cross-cloud plan actually succeeding
 * end-to-end with a mocked terraform exec) is covered by the TaskMockRunner
 * scenarios under Tests/PlanTests/BackendDecoupling/.
 */
describe('ParentCommandHandler cross-cloud backend credential injection', function () {
  const tmpDirs: string[] = [];
  const originalGetInput = tasks.getInput;

  function makeWorkingDirectoryWithBackend(backendType: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-handler-cross-cloud-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.terraform'));
    fs.writeFileSync(
      path.join(dir, '.terraform', 'terraform.tfstate'),
      JSON.stringify({ backend: { type: backendType } }),
    );
    return dir;
  }

  /** Mimics the real getInput(name, required) contract: throws when required and falsy. */
  function mockInputs(values: Record<string, string | undefined>): void {
    (tasks as any).getInput = (name: string, required?: boolean) => {
      const val = values[name];
      if (required && !val) {
        throw new Error(`Input required: ${name}`);
      }
      return val;
    };
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    (tasks as any).getInput = originalGetInput;
    EnvironmentVariableHelper.clearTrackedVariables();
  });

  it('cross-cloud (aws provider + azurerm backend) plan throws an actionable error naming the detected backend when backend inputs are missing', async () => {
    const workDir = makeWorkingDirectoryWithBackend('azurerm');
    mockInputs({ workingDirectory: workDir }); // no backendServiceArm

    await assert.rejects(
      () => new ParentCommandHandler().execute('aws', 'plan'),
      (err: Error) => {
        assert.match(err.message, /Cross-cloud state backend credential setup failed for command 'plan'/);
        assert.match(err.message, /'azurerm'/);
        assert.match(err.message, /'aws'/);
        return true;
      },
    );
  });

  it('same-cloud (aws provider + s3 backend) does not attempt cross-cloud injection', async () => {
    const workDir = makeWorkingDirectoryWithBackend('s3');
    mockInputs({ workingDirectory: workDir }); // no AWS provider inputs either

    await assert.rejects(
      () => new ParentCommandHandler().execute('aws', 'plan'),
      (err: Error) => {
        assert.ok(
          !/Cross-cloud state backend credential setup failed/.test(err.message),
          `same-cloud setup should not report a cross-cloud backend error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('STATE_COMMANDS includes only commands that read/write remote state', () => {
    for (const expected of ['plan', 'apply', 'destroy', 'refresh', 'import', 'output', 'state', 'workspace', 'forceunlock']) {
      assert.ok(STATE_COMMANDS.has(expected), `expected STATE_COMMANDS to include '${expected}'`);
    }
    for (const excluded of ['init', 'validate', 'fmt', 'get', 'test', 'show', 'custom']) {
      assert.ok(!STATE_COMMANDS.has(excluded), `expected STATE_COMMANDS to exclude '${excluded}'`);
    }
  });
});
