import tl = require('azure-pipelines-task-lib');
import { execFileSync } from 'child_process';
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        // Real saved plan to apply, created directly (bypassing the task) so
        // this scenario tests ONLY apply()'s own argv-build.
        execFileSync('terraform', ['plan', '-out=x.tfplan', '-no-color'], { cwd: workingDirectory, stdio: 'pipe' });

        const handler = new TerraformCommandHandlerAzureRM();
        const response = await handler.apply();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, `Regression613ApplyL0: expected apply() to return 0, got ${response}.`);
            return;
        }

        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'Regression613ApplyL0 should have succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `Regression613ApplyL0: apply() threw -- ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();
