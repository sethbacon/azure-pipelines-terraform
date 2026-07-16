import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured apply-summary attach path (design §7/D2), success case: asserts
 * exit code 0 is preserved, a redacted terraform-apply-summary attachment is
 * emitted reflecting the mocked apply, and each event's @message (not the raw
 * NDJSON) is echoed to the console.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().apply();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: expected apply() to return 0, got ${response}.`);
        return;
    }

    if (!stdout.includes('azurerm_resource_group.example: Creation complete after 2s')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: expected the human-readable @message to be echoed to the console. stdout: ${stdout}`);
        return;
    }
    if (stdout.includes('"type":"apply_complete"')) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplySuccessPublishResultsL0: raw NDJSON structured fields leaked to the console instead of only the @message.');
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-apply-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplySuccessPublishResultsL0: no terraform-apply-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== 'my-apply') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: expected attachment name 'my-apply', got '${summaryAttachment.name}'.`);
        return;
    }

    let digest: {
        schemaVersion: number;
        kind: string;
        outcome: string;
        resources: Array<{ address: string; action: string; status: string }>;
        outputs: Array<{ name: string; value: { kind: string; json?: string } }>;
    };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.schemaVersion !== 1 || digest.kind !== 'apply' || digest.outcome !== 'succeeded') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: unexpected digest envelope: ${JSON.stringify({ schemaVersion: digest.schemaVersion, kind: digest.kind, outcome: digest.outcome })}`);
        return;
    }
    if (digest.resources.length !== 1 || digest.resources[0].address !== 'azurerm_resource_group.example' || digest.resources[0].status !== 'complete') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }
    if (digest.outputs.length !== 1 || digest.outputs[0].name !== 'rg_name' || digest.outputs[0].value.kind !== 'value' || digest.outputs[0].value.json !== '"example-rg"') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplySuccessPublishResultsL0: unexpected digest outputs: ${JSON.stringify(digest.outputs)}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureApplySuccessPublishResultsL0 should have succeeded.');
}

void run();
