import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * #612 (sibling): destroy() with a user-supplied `-out=userdestroy.tfplan` in
 * commandOptions and publishPlanSummary set. Reaching exit 0 against a mock that
 * answers ONLY the single-`-out` destroy command proves no second (task-owned)
 * `-out=` was injected; the digest is built from the user's own saved plan.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().destroy();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyUserOutHonoredL0: expected destroy() to return 0 with exactly one -out, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureDestroyUserOutHonoredL0: no terraform-plan-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== 'my-destroy-summary') {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyUserOutHonoredL0: expected attachment name 'my-destroy-summary', got '${summaryAttachment.name}'.`);
        return;
    }

    let digest: { kind: string; planMode?: string; resources: Array<{ address: string; actions: string[] }> };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyUserOutHonoredL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.kind !== 'plan' || digest.planMode !== 'destroy') {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyUserOutHonoredL0: unexpected digest envelope: ${JSON.stringify({ kind: digest.kind, planMode: digest.planMode })}`);
        return;
    }
    if (digest.resources.length !== 1 || !digest.resources[0].actions.includes('delete')) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyUserOutHonoredL0: digest was not built from the user's saved destroy plan: ${JSON.stringify(digest.resources)}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureDestroyUserOutHonoredL0 should have succeeded.');
}

void run();
