import tl = require('azure-pipelines-task-lib');
import { execFileSync } from 'child_process';
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        // Real state to show, created directly (bypassing the task) so this
        // scenario tests ONLY show()'s own argv-build.
        execFileSync('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: workingDirectory, stdio: 'pipe' });

        const handler = new TerraformCommandHandlerAzureRM();
        const response = await handler.show();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, `BaselineShowStateResultsL0: expected show() to return 0, got ${response}.`);
            return;
        }
        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'BaselineShowStateResultsL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();
