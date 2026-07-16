import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured plan-summary attach path (design §7/D1): publishPlanSummary set,
 * publishPlanResults NOT set. Asserts a redacted terraform-plan-summary
 * attachment is emitted (and NO terraform-plan-results attachment, since that
 * input was not set) and that the attached digest reflects the mocked plan.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().plan();
    });

    if (response !== 2) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: expected plan() to return 2 (changes present), got ${response}.`);
        return;
    }

    const rawAttachment = findAttachmentCommand(stdout, 'terraform-plan-results');
    if (rawAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanSuccessPublishSummaryL0: publishPlanResults was not set but a terraform-plan-results attachment was emitted anyway.');
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanSuccessPublishSummaryL0: no terraform-plan-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== 'my-summary') {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: expected attachment name 'my-summary', got '${summaryAttachment.name}'.`);
        return;
    }
    if (!fs.existsSync(summaryAttachment.path)) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: attachment file does not exist on disk: ${summaryAttachment.path}`);
        return;
    }

    let digest: { schemaVersion: number; kind: string; resources: Array<{ address: string; actions: string[] }>; summary: { add: number } };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.schemaVersion !== 1 || digest.kind !== 'plan') {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: unexpected digest envelope: ${JSON.stringify({ schemaVersion: digest.schemaVersion, kind: digest.kind })}`);
        return;
    }
    if (digest.resources.length !== 1 || digest.resources[0].address !== 'azurerm_resource_group.example' || !digest.resources[0].actions.includes('create')) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }
    if (digest.summary.add !== 1) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanSuccessPublishSummaryL0: unexpected digest summary: ${JSON.stringify(digest.summary)}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanSuccessPublishSummaryL0 should have succeeded.');
}

void run();
