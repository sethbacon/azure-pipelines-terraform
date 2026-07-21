import tl = require('azure-pipelines-task-lib');
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        const handler = new TerraformCommandHandlerAzureRM();
        const response = await handler.apply();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, `BaselineApplyResultsL0: expected apply() to return 0, got ${response}.`);
            return;
        }
        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'BaselineApplyResultsL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();
