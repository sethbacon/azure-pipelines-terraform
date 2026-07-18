import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');

/**
 * #613 compounding issue: a structured apply that fails writing ONLY to stderr
 * (empty stdout) must still fail the task AND surface the stderr text, rather
 * than swallowing it behind a bare "exit code 1". apply() must throw, and the
 * thrown message must carry the captured stderr.
 */
async function run(): Promise<void> {
    let thrown: unknown;
    await captureStdout(async () => {
        try {
            await new TerraformCommandHandlerAzureRM().apply();
        } catch (error) {
            thrown = error;
        }
    });

    if (!thrown) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplySavedPlanStderrSurfacedL0: apply() should have thrown on a non-zero exit code but did not.');
        return;
    }
    const message = String(thrown);
    // Still fails with the usual apply-failed key (mock tasks.loc() falls back to
    // the message KEY when no resource file is loaded).
    if (!message.includes('TerraformApplyFailed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanStderrSurfacedL0: expected the apply-failed error, got: ${message}`);
        return;
    }
    // The critical assertion: the stderr text (the ONLY diagnostic terraform
    // produced) must be surfaced in the failure, not swallowed.
    if (!message.includes('Failed to read plan from plan file')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanStderrSurfacedL0: the terraform stderr was swallowed -- it must appear in the failure output. Got: ${message}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureApplySavedPlanStderrSurfacedL0 should have succeeded.');
}

void run();
