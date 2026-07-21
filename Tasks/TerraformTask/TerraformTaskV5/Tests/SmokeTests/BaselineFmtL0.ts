import tl = require('azure-pipelines-task-lib');
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        const handler = new TerraformCommandHandlerAzureRM();
        const response = await handler.fmt();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, `BaselineFmtL0: expected fmt() to return 0 (fixture is already canonically formatted), got ${response}.`);
            return;
        }
        tl.setResult(tl.TaskResult.Succeeded, 'BaselineFmtL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();
