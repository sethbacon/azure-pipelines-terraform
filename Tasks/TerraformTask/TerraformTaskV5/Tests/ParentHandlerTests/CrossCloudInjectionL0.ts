import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { ParentCommandHandler, STATE_COMMANDS } from '../../src/parent-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';

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
describe('ParentCommandHandler backend credential injection', function () {
  const tmpDirs: string[] = [];
  const originalGetInput = tasks.getInput;

  function makeWorkingDirectoryWithBackend(backendType: string, config?: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-handler-cross-cloud-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.terraform'));
    fs.writeFileSync(
      path.join(dir, '.terraform', 'terraform.tfstate'),
      JSON.stringify({ backend: { type: backendType, ...(config ? { config } : {}) } }),
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

  // #1180: the backend and the provider being the same cloud does not mean
  // they are the same identity.
  describe('same cloud, separate service connections', () => {
    it('azurerm backend + azurerm provider on one connection stays a no-op', async () => {
      const workDir = makeWorkingDirectoryWithBackend('azurerm');
      mockInputs({
        workingDirectory: workDir,
        backendServiceArm: 'SC-SHARED',
        environmentServiceNameAzureRM: 'SC-SHARED',
      });

      await assert.rejects(
        () => new ParentCommandHandler().execute('azurerm', 'plan'),
        (err: Error) => {
          assert.ok(
            !/Refusing to run/.test(err.message),
            `one shared connection is unambiguous and must not be rejected, got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('azurerm backend on a different connection fails closed rather than silently using the provider identity', async () => {
      const workDir = makeWorkingDirectoryWithBackend('azurerm');
      mockInputs({
        workingDirectory: workDir,
        backendServiceArm: 'SC-BACKEND',
        environmentServiceNameAzureRM: 'SC-PROVIDER',
      });

      await assert.rejects(
        () => new ParentCommandHandler().execute('azurerm', 'plan'),
        (err: Error) => {
          assert.match(err.message, /Refusing to run 'plan'/);
          assert.match(err.message, /backendServiceArm/);
          assert.match(err.message, /environmentServiceNameAzureRM/);
          assert.match(err.message, /ARM_\*/);
          // Every remedy the user can actually act on.
          assert.match(err.message, /backendAzureRmUseCliFlagsForAuthentication/);
          assert.match(err.message, /input variables/);
          assert.match(err.message, /same service connection for both/);
          return true;
        },
      );
    });

    it('s3 backend on a different connection fails closed and cites the AWS inputs', async () => {
      const workDir = makeWorkingDirectoryWithBackend('s3');
      mockInputs({
        workingDirectory: workDir,
        backendServiceAWS: 'SC-BACKEND',
        environmentServiceNameAWS: 'SC-PROVIDER',
      });

      await assert.rejects(
        () => new ParentCommandHandler().execute('aws', 'plan'),
        (err: Error) => {
          assert.match(err.message, /Refusing to run 'plan'/);
          assert.match(err.message, /backendServiceAWS/);
          assert.match(err.message, /AWS_\*/);
          return true;
        },
      );
    });

    it('accepts a different connection when init already bound the backend to its own credential', async () => {
      // What backendAzureRmUseCliFlagsForAuthentication: true leaves behind.
      const workDir = makeWorkingDirectoryWithBackend('azurerm', {
        client_id: '00000000-0000-0000-0000-000000000000',
        use_oidc: true,
      });
      mockInputs({
        workingDirectory: workDir,
        backendServiceArm: 'SC-BACKEND',
        environmentServiceNameAzureRM: 'SC-PROVIDER',
      });

      await assert.rejects(
        () => new ParentCommandHandler().execute('azurerm', 'plan'),
        (err: Error) => {
          assert.ok(
            !/Refusing to run/.test(err.message),
            `a backend bound at init resolves its own credential and must keep working, got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('gcs backend on a different connection injects, since GOOGLE_BACKEND_CREDENTIALS is the backend\'s alone', async () => {
      const workDir = makeWorkingDirectoryWithBackend('gcs');
      mockInputs({
        workingDirectory: workDir,
        backendServiceGCP: 'SC-BACKEND',
        environmentServiceNameGCP: 'SC-PROVIDER',
      });

      await assert.rejects(
        () => new ParentCommandHandler().execute('gcp', 'plan'),
        (err: Error) => {
          assert.ok(
            !/Refusing to run/.test(err.message),
            `gcp can express two identities and must not be rejected, got: ${err.message}`,
          );
          // Proves injection was attempted rather than skipped.
          assert.match(err.message, /State backend credential setup failed for command 'plan'/);
          return true;
        },
      );
    });
  });
});
