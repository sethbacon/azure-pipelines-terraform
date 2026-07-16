import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');

/**
 * Backward-compat regression (Phase 5 §5.5): a destroy run WITHOUT
 * publishPlanSummary set must behave byte-identically to pre-Phase-5 destroy
 * -- same command line (no `-out=`), same exit code, and NO
 * terraform-plan-summary attachment.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().destroy();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyPublishSummaryBackwardCompatL0: expected destroy() to return 0, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureDestroyPublishSummaryBackwardCompatL0: publishPlanSummary was not set but a terraform-plan-summary attachment was emitted anyway.');
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureDestroyPublishSummaryBackwardCompatL0 should have succeeded.');
}

void run();
