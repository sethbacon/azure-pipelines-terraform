import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../test-l0-helpers';
import { sanitizeAttachmentName } from './../../src/results/secret-scrub';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Name-injection rejection for publishStateResults (Phase 5 §5.5, mirroring
 * design §5.6 / AzurePlanPublishSummaryNameInjectionRejectedL0.ts): a
 * publishStateResults value carrying CR/LF and ]/;/% control sequences must
 * not reach the emitted ##vso[task.addattachment ...] logging command, or the
 * digest's own meta.name, unsanitized. Reuses the WP-1 sanitizeAttachmentName()
 * as the expected-value oracle -- this only proves
 * base-terraform-command-handler.ts calls it via buildStateDigest, not that
 * the sanitizer itself is correct (that matrix lives in
 * Tests/results/SecretScrubL0.ts).
 */
async function run(): Promise<void> {
    const rawName = 'evil\r\nname];type=warning;%oops';
    const expectedName = sanitizeAttachmentName(rawName).name;

    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().show();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStatePublishSummaryNameInjectionRejectedL0: expected show() to return 0, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-state-summary');
    if (!summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureShowStatePublishSummaryNameInjectionRejectedL0: no terraform-state-summary attachment was emitted.');
        return;
    }
    if (summaryAttachment.name !== expectedName) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStatePublishSummaryNameInjectionRejectedL0: attachment name was not sanitized. Expected '${expectedName}', got '${summaryAttachment.name}'.`);
        return;
    }
    if (/[\r\n\]%;]/.test(summaryAttachment.name)) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStatePublishSummaryNameInjectionRejectedL0: attachment name still contains an injection character: '${summaryAttachment.name}'.`);
        return;
    }

    let digest: { meta: { name: string } };
    try {
        digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStatePublishSummaryNameInjectionRejectedL0: attachment file was not valid JSON: ${error}`);
        return;
    } finally {
        try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.meta.name !== expectedName) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowStatePublishSummaryNameInjectionRejectedL0: digest meta.name was not sanitized. Expected '${expectedName}', got '${digest.meta.name}'.`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureShowStatePublishSummaryNameInjectionRejectedL0 should have succeeded.');
}

void run();
