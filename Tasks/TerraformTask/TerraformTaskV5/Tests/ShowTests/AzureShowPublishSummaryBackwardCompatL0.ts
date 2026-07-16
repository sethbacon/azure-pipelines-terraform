import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');

/**
 * Backward-compat regression (Phase 5 §5.5): a show run WITHOUT
 * publishStateResults set must behave byte-identically to pre-Phase-5 show --
 * same (single) exec call, same exit code, and NO terraform-state-summary
 * attachment (i.e. no second `terraform show -json` invocation at all).
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().show();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowPublishSummaryBackwardCompatL0: expected show() to return 0, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-state-summary');
    if (summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureShowPublishSummaryBackwardCompatL0: publishStateResults was not set but a terraform-state-summary attachment was emitted anyway.');
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureShowPublishSummaryBackwardCompatL0 should have succeeded.');
}

void run();
