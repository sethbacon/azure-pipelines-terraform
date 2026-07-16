import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured destroy-summary attach path, failure case (Phase 5 §5.5): proves
 * exit-code semantics are preserved EXACTLY -- destroy() must still
 * auto-approve and still fail/throw on a non-zero exit, precisely as it does
 * without publishPlanSummary set -- while the redacted destroy PlanDigest is
 * still attached (the plan file is written during planning, before the
 * auto-approved apply phase that failed).
 */
async function run(): Promise<void> {
    let thrown: unknown;
    const stdout = await captureStdout(async () => {
        try {
            await new TerraformCommandHandlerAzureRM().destroy();
        } catch (error) {
            thrown = error;
        }
    });

    if (!thrown) {
        tl.setResult(tl.TaskResult.Failed, 'AzureDestroyFailurePublishSummaryExitCodePreservedL0: destroy() should have thrown on a non-zero exit code but did not.');
        return;
    }
    // Without a loaded resource file the mock tasks.loc() falls back to the
    // message KEY itself (see AzureApplyFailurePublishResultsExitCodePreservedL0
    // for the same pattern), so assert on the key rather than the formatted text.
    if (!String(thrown).includes('TerraformDestroyFailed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyFailurePublishSummaryExitCodePreservedL0: unexpected error: ${thrown}`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureDestroyFailurePublishSummaryExitCodePreservedL0: a failed destroy must still emit a terraform-plan-summary attachment.');
        return;
    }

    let digest: { kind: string; planMode?: string; resources: Array<{ address: string; actions: string[] }> };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyFailurePublishSummaryExitCodePreservedL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.planMode !== 'destroy') {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyFailurePublishSummaryExitCodePreservedL0: expected digest.planMode 'destroy', got '${digest.planMode}'.`);
        return;
    }
    if (digest.resources.length !== 1 || !digest.resources[0].actions.includes('delete')) {
        tl.setResult(tl.TaskResult.Failed, `AzureDestroyFailurePublishSummaryExitCodePreservedL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureDestroyFailurePublishSummaryExitCodePreservedL0 should have succeeded.');
}

void run();
