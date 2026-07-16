import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Structured state-summary attach path (Phase 5 §5.5): publishStateResults
 * set on a STATE show (no plan-file positional argument) must run a SEPARATE
 * `terraform show -json` of the current state and attach a redacted
 * StateDigest -- resources (managed + data), outputs, and the `sensitive`
 * output redacted to `{kind:"sensitive"}` with no raw value present anywhere
 * in the serialized attachment (no-leak spot check; the full redaction matrix
 * lives in Tests/results/StateDigestL0.ts).
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().show();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: expected show() to return 0, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-state-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureShowStateSuccessPublishSummaryL0: no terraform-state-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== 'my-state') {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: expected attachment name 'my-state', got '${summaryAttachment.name}'.`);
        return;
    }

    let raw: string;
    let digest: {
        schemaVersion: number;
        kind: string;
        resources: Array<{ address: string; mode: string }>;
        outputs: Array<{ name: string; value: unknown }>;
        summary: { resourceCount: number; dataSourceCount: number };
    };
    try {
        raw = fs.readFileSync(summaryAttachment.path, 'utf-8');
        digest = JSON.parse(raw);
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.schemaVersion !== 1 || digest.kind !== 'state') {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: unexpected digest envelope: ${JSON.stringify({ schemaVersion: digest.schemaVersion, kind: digest.kind })}`);
        return;
    }
    if (digest.summary.resourceCount !== 1 || digest.summary.dataSourceCount !== 1) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: unexpected digest summary: ${JSON.stringify(digest.summary)}`);
        return;
    }
    if (digest.resources.length !== 2 || !digest.resources.some(r => r.address === 'azurerm_resource_group.example' && r.mode === 'managed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: unexpected digest resources: ${JSON.stringify(digest.resources)}`);
        return;
    }
    const connString = digest.outputs.find(o => o.name === 'connection_string');
    if (!connString || (connString.value as { kind?: string }).kind !== 'sensitive') {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStateSuccessPublishSummaryL0: sensitive output was not redacted: ${JSON.stringify(connString)}`);
        return;
    }
    // No-leak spot check: the raw secret must not appear anywhere in the
    // serialized digest, regardless of shape.
    if (raw.includes('hunter2')) {
        tl.setResult(tl.TaskResult.Failed, 'AzureShowStateSuccessPublishSummaryL0: raw secret value leaked into the serialized state digest.');
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureShowStateSuccessPublishSummaryL0 should have succeeded.');
}

void run();
