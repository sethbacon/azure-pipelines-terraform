import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured apply-summary attach path (design §7/D2), safe-default case:
 * proves that when the `includeDiagnostics` input is left UNSET, the
 * published structured apply summary contains NO diagnostics -- the input
 * now defaults to opt-in (off), so a provider-echoed secret in a diagnostic
 * cannot reach the (build-read-wide) attachment unless an operator
 * explicitly enables it. The apply outcome and per-resource status are still
 * published so the failure remains visible.
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
        tl.setResult(tl.TaskResult.Failed, 'AzureApplyDefaultOmitsDiagnosticsL0: apply() should have thrown on a non-zero exit code but did not.');
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-apply-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplyDefaultOmitsDiagnosticsL0: a failed apply must still emit a terraform-apply-summary attachment.');
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
        tl.setResult(tl.TaskResult.Failed, `AzureApplyDefaultOmitsDiagnosticsL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    // Outcome/resource status are still published even though diagnostics are
    // omitted -- the failure itself must remain visible without the operator
    // opting in to freeform diagnostic text.
    if (digest.outcome !== 'failed') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyDefaultOmitsDiagnosticsL0: expected digest.outcome 'failed', got '${digest.outcome}'.`);
        return;
    }
    if (digest.resources.length !== 1 || digest.resources[0].status !== 'errored') {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyDefaultOmitsDiagnosticsL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }
    if (!Array.isArray(digest.diagnostics) || digest.diagnostics.length !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyDefaultOmitsDiagnosticsL0: expected an empty diagnostics array by default, got: ${JSON.stringify(digest.diagnostics)}`);
        return;
    }
    if (JSON.stringify(digest).includes('already exists')) {
        tl.setResult(tl.TaskResult.Failed, 'AzureApplyDefaultOmitsDiagnosticsL0: freeform diagnostic text leaked into the attachment despite includeDiagnostics defaulting to off.');
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureApplyDefaultOmitsDiagnosticsL0 should have succeeded.');
}

void run();
