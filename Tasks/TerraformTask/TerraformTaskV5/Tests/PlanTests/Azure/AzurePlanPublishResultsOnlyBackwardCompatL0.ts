import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Backward-compat regression (design §12.3): a publishPlanResults-only run
 * (publishPlanSummary not set) must still emit the byte-identical
 * terraform-plan-results attachment -- same name, same file content as the
 * mocked plan stdout -- and must emit NO terraform-plan-summary attachment.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().plan();
    });

    if (response !== 2) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsOnlyBackwardCompatL0: expected plan() to return 2 (changes present), got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanPublishResultsOnlyBackwardCompatL0: publishPlanSummary was not set but a terraform-plan-summary attachment was emitted anyway.');
        return;
    }

    const rawAttachment = findAttachmentCommand(stdout, 'terraform-plan-results');
    if (!rawAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanPublishResultsOnlyBackwardCompatL0: no terraform-plan-results attachment was emitted.');
        return;
    }
    if (rawAttachment.name !== 'my-plan') {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsOnlyBackwardCompatL0: expected attachment name 'my-plan', got '${rawAttachment.name}'.`);
        return;
    }

    let content: string;
    try {
        content = fs.readFileSync(rawAttachment.path, 'utf-8');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsOnlyBackwardCompatL0: could not read attachment file: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(rawAttachment.path); } catch { /* ignore */ }
    }

    const expected = 'Plan: 1 to add, 0 to change, 0 to destroy.';
    if (content !== expected) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsOnlyBackwardCompatL0: attachment content was not byte-identical to the mocked plan stdout. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(content)}.`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanPublishResultsOnlyBackwardCompatL0 should have succeeded.');
}

void run();
