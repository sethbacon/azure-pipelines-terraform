import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * #612: plan() with a user-supplied `-out=userplan.tfplan` in commandOptions and
 * publishPlanSummary set. Asserts:
 *  - plan() reaches the changes-present exit (2) against a mock that answers ONLY
 *    the single-`-out` command -- proving no second (task-owned) `-out=` was
 *    injected (the broken code would have appended one and missed the mock);
 *  - the redacted terraform-plan-summary digest is built from the USER's own
 *    saved plan (the `show -json userplan.tfplan` answer);
 *  - end-of-step cleanup does NOT delete the user's plan file.
 */
async function run(): Promise<void> {
    const userPlanFile = 'userplan.tfplan';
    // A real on-disk file standing in for the user's saved plan, so we can prove
    // cleanupTempFiles() leaves it untouched.
    fs.writeFileSync(userPlanFile, 'dummy plan bytes');

    try {
        const handler = new TerraformCommandHandlerAzureRM();
        let response: number | undefined;
        const stdout = await captureStdout(async () => {
            response = await handler.plan();
        });

        if (response !== 2) {
            tl.setResult(tl.TaskResult.Failed, `AzurePlanUserOutHonoredL0: expected plan() to return 2 (changes present) with exactly one -out, got ${response}.`);
            return;
        }

        const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
        if (!summaryAttachment) {
            tl.setResult(tl.TaskResult.Failed, 'AzurePlanUserOutHonoredL0: no terraform-plan-summary attachment was emitted (digest must be built from the user plan path).');
            return;
        }
        if (summaryAttachment.name !== 'my-summary') {
            tl.setResult(tl.TaskResult.Failed, `AzurePlanUserOutHonoredL0: expected attachment name 'my-summary', got '${summaryAttachment.name}'.`);
            return;
        }

        let digest: { kind: string; resources: Array<{ address: string; actions: string[] }> };
        try {
            digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
        } catch (error) {
            tl.setResult(tl.TaskResult.Failed, `AzurePlanUserOutHonoredL0: attachment file was not valid JSON: ${error}`);
            return;
        } finally {
            try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
        }

        if (digest.kind !== 'plan' || digest.resources.length !== 1 || digest.resources[0].address !== 'azurerm_resource_group.example') {
            tl.setResult(tl.TaskResult.Failed, `AzurePlanUserOutHonoredL0: digest was not built from the user's saved plan: ${JSON.stringify(digest.resources)}`);
            return;
        }

        // The user's plan file must survive step cleanup (it is never tracked in
        // tempFiles; only task-owned temp files are).
        handler.cleanupTempFiles();
        if (!fs.existsSync(userPlanFile)) {
            tl.setResult(tl.TaskResult.Failed, "AzurePlanUserOutHonoredL0: cleanupTempFiles() deleted the user's plan file -- it must never be tracked for cleanup.");
            return;
        }

        tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanUserOutHonoredL0 should have succeeded.');
    } finally {
        try { fs.unlinkSync(userPlanFile); } catch { /* ignore */ }
    }
}

void run();
