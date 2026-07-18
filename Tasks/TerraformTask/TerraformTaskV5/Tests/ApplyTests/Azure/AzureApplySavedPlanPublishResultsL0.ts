import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * #613 primary bug: apply of a SAVED PLAN (positional plan-file path in
 * commandOptions) with publishApplyResults set. The mock only answers the
 * corrected argv order `terraform apply -auto-approve -json tfplan` (`-json`
 * BEFORE the positional). Reaching exit code 0 and attaching the summary proves
 * the emitted command placed `-json` before the plan file -- the old order
 * (`... tfplan -json`) would miss the mock and reject.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().apply();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanPublishResultsL0: expected apply() to return 0 (proves -json preceded the positional plan file), got ${response}.`);
        return;
    }

    if (!stdout.includes('azurerm_resource_group.example: Creation complete after 2s')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanPublishResultsL0: expected the human-readable @message to be echoed to the console. stdout: ${stdout}`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-apply-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplySavedPlanPublishResultsL0: no terraform-apply-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== 'my-apply') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanPublishResultsL0: expected attachment name 'my-apply', got '${summaryAttachment.name}'.`);
        return;
    }

    let digest: { schemaVersion: number; kind: string; outcome: string };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanPublishResultsL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.schemaVersion !== 1 || digest.kind !== 'apply' || digest.outcome !== 'succeeded') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySavedPlanPublishResultsL0: unexpected digest envelope: ${JSON.stringify({ schemaVersion: digest.schemaVersion, kind: digest.kind, outcome: digest.outcome })}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureApplySavedPlanPublishResultsL0 should have succeeded.');
}

void run();
