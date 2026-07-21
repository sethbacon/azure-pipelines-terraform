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
      tl.setResult(tl.TaskResult.Failed, `BaselinePlainPlanL0: expected plan() to return 2 (changes present), got ${response}.`);
      return;
    }
    handler.cleanupTempFiles();
    tl.setResult(tl.TaskResult.Succeeded, 'BaselinePlainPlanL0 should have succeeded.');
  } finally {
    cleanupScratchFixture(workingDirectory);
  }
}

run();
