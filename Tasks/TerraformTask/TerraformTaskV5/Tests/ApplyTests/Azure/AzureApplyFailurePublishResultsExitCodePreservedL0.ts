import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured apply-summary attach path (design §7/D2), failure case: proves
 * exit-code semantics are preserved EXACTLY -- apply() must still fail/throw
 * on a non-zero exit, precisely as it does without publishApplyResults set --
 * while the redacted ApplyDigest (outcome "failed", including the resource
 * that errored and its diagnostic) is still attached, giving the failed run's
 * partial-apply picture.
 */
async function run(): Promise<void> {
    let thrown: unknown;
    const stdout = await captureStdout(async () => {
        try {
            await new TerraformCommandHandlerAzureRM().apply();
        } catch (error) {
            thrown = error;
        }
    });

    if (!thrown) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplyFailurePublishResultsExitCodePreservedL0: apply() should have thrown on a non-zero exit code but did not.');
        return;
    }
    // Without a loaded resource file the mock tasks.loc() falls back to the
    // message KEY itself (see other strict-failure tests in this suite for the
    // same pattern), so assert on the key rather than the formatted text.
    if (!String(thrown).includes('TerraformApplyFailed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyFailurePublishResultsExitCodePreservedL0: unexpected error: ${thrown}`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-apply-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplyFailurePublishResultsExitCodePreservedL0: a failed apply must still emit a terraform-apply-summary attachment.');
        return;
    }

    let digest: {
        outcome: string;
        resources: Array<{ address: string; status: string }>;
        diagnostics: Array<{ severity: string; summary: string; detail?: string }>;
    };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyFailurePublishResultsExitCodePreservedL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.outcome !== 'failed') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyFailurePublishResultsExitCodePreservedL0: expected digest.outcome 'failed', got '${digest.outcome}'.`);
        return;
    }
    if (digest.resources.length !== 1 || digest.resources[0].status !== 'errored') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyFailurePublishResultsExitCodePreservedL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }
    if (digest.diagnostics.length !== 1 || digest.diagnostics[0].severity !== 'error') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyFailurePublishResultsExitCodePreservedL0: unexpected digest diagnostics: ${JSON.stringify(digest.diagnostics)}`);
        return;
    }
    // includeDiagnosticDetail defaults to false: the more leak-prone 'detail'
    // field must be omitted from the attached digest.
    if (digest.diagnostics[0].detail !== undefined) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyFailurePublishResultsExitCodePreservedL0: diagnostic 'detail' should be omitted by default, got: ${digest.diagnostics[0].detail}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureApplyFailurePublishResultsExitCodePreservedL0 should have succeeded.');
}

void run();
