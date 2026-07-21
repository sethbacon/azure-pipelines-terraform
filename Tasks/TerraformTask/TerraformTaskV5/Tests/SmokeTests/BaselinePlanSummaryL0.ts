import tl = require('azure-pipelines-task-lib');
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
  const workingDirectory = tl.getInput('workingDirectory')!;
  try {
    realTerraformInit(workingDirectory);
    const handler = new TerraformCommandHandlerAzureRM();
    const response = await handler.plan();
    if (response !== 2) {
      tl.setResult(tl.TaskResult.Failed, `BaselinePlanSummaryL0: expected plan() to return 2 (changes present), got ${response}.`);
      return;
    }
    // No user -out was supplied, so the task must have injected its own
    // tempfile -out (Agent.TempDirectory falls back to os.tmpdir() when
    // unset) and built a real plan-summary digest from it -- proven by the
    // real ##vso[task.addattachment] logging command real task-lib emits.
    if (!tl.getVariable('changesPresent') || tl.getVariable('changesPresent') !== 'true') {
      tl.setResult(tl.TaskResult.Failed, "BaselinePlanSummaryL0: expected changesPresent variable to be 'true'.");
      return;
    }
    handler.cleanupTempFiles();
    tl.setResult(tl.TaskResult.Succeeded, 'BaselinePlanSummaryL0 should have succeeded.');
  } finally {
    cleanupScratchFixture(workingDirectory);
  }
}

run();
