import tl = require('azure-pipelines-task-lib');
import { execFileSync } from 'child_process';
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        // Real state to destroy: apply directly (bypassing the task) so this
        // scenario tests ONLY destroy()'s own argv-build (commandOptions
        // forwarding + auto-approve), not apply()'s.
        execFileSync('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: workingDirectory, stdio: 'pipe' });

        const stateBefore = JSON.parse(execFileSync('terraform', ['show', '-json'], { cwd: workingDirectory, encoding: 'utf-8' }));
        if (!stateBefore.values || !stateBefore.values.root_module || !stateBefore.values.root_module.resources || stateBefore.values.root_module.resources.length !== 1) {
            tl.setResult(tl.TaskResult.Failed, 'Regression612DestroyL0: sanity check failed -- expected exactly 1 real resource in state before destroy.');
            return;
        }

        const handler = new TerraformCommandHandlerAzureRM();
        const response = await handler.destroy();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, `Regression612DestroyL0: expected destroy() to return 0, got ${response}.`);
            return;
        }

        // commandOptions (-var=env=prod) must have been forwarded and accepted
        // (a wrong argv shape would have made this whole command fail above).
        // An empty state's `terraform show -json` still has a top-level
        // format_version key, just no `values` key at all.
        const stateAfter = JSON.parse(execFileSync('terraform', ['show', '-json'], { cwd: workingDirectory, encoding: 'utf-8' }));
        if (stateAfter.values !== undefined) {
            tl.setResult(tl.TaskResult.Failed, `Regression612DestroyL0: expected no resources left in state after destroy, got: ${JSON.stringify(stateAfter)}`);
            return;
        }

        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'Regression612DestroyL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();

