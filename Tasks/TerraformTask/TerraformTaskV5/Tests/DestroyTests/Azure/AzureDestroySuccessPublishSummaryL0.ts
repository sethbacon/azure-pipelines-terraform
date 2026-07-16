import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured destroy-summary attach path (Phase 5 §5.5): destroy REUSES
 * PlanDigest -- a destroy plan is a plan whose resource_changes are all
 * deletes. publishPlanSummary set on `destroy` must add `-out=<planfile>` to
 * the auto-approved destroy invocation, run `terraform show -json` on it, and
 * attach a redacted `terraform-plan-summary` digest with `planMode: "destroy"`
 * so the tab can label the view. Destroy still auto-approves and the exit
 * code (0) is unaffected by publishing the summary.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().destroy();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: expected destroy() to return 0, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureDestroySuccessPublishSummaryL0: no terraform-plan-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== 'my-destroy-summary') {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: expected attachment name 'my-destroy-summary', got '${summaryAttachment.name}'.`);
        return;
    }

    let digest: {
        schemaVersion: number;
        kind: string;
        planMode?: string;
        resources: Array<{ address: string; actions: string[] }>;
        summary: { destroy: number };
    };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.schemaVersion !== 1 || digest.kind !== 'plan') {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: unexpected digest envelope: ${JSON.stringify({ schemaVersion: digest.schemaVersion, kind: digest.kind })}`);
        return;
    }
    if (digest.planMode !== 'destroy') {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: expected digest.planMode 'destroy', got '${digest.planMode}'.`);
        return;
    }
    if (digest.resources.length !== 1 || digest.resources[0].address !== 'azurerm_resource_group.example' || !digest.resources[0].actions.includes('delete')) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }
    if (digest.summary.destroy !== 1) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroySuccessPublishSummaryL0: unexpected digest summary: ${JSON.stringify(digest.summary)}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureDestroySuccessPublishSummaryL0 should have succeeded.');
}

void run();
