import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../../test-l0-helpers';
import { sanitizeAttachmentName } from './../../../src/results/secret-scrub';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * COMPAT regression: the legacy terraform-plan-results attachment name must be
 * passed RAW to tasks.addAttachment(), exactly as it was before the structured
 * plan/apply-summary feature. azure-pipelines-task-lib ESCAPES the value into the
 * ##vso[task.addattachment ...;name=NAME;] logging command (its taskcommand.escape
 * turns %/CR/LF/]/; into %AZP25/%0D/%0A/%5D/%3B), so a publishPlanResults-only run
 * stays byte-for-byte identical. Running the name through sanitizeAttachmentName()
 * (which STRIPS those characters) would change that behavior -- this test proves
 * the RAW name reaches the command, not the stripped one.
 */

// Reverse of azure-pipelines-task-lib taskcommand.escape() (see its unescape()).
function unescapeCommandValue(s: string): string {
    return s
        .replace(/%0D/g, '\r')
        .replace(/%0A/g, '\n')
        .replace(/%5D/g, ']')
        .replace(/%3B/g, ';')
        .replace(/%AZP25/g, '%');
}

async function run(): Promise<void> {
    const rawName = 'raw;plan]name%end';
    const strippedName = sanitizeAttachmentName(rawName).name; // what the WRONG (sanitized) path would emit

    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().plan();
    });

    if (response !== 2) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsRawNameCompatL0: expected plan() to return 2 (changes present), got ${response}.`);
        return;
    }

    const rawAttachment = findAttachmentCommand(stdout, 'terraform-plan-results');
    if (!rawAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanPublishResultsRawNameCompatL0: no terraform-plan-results attachment was emitted.');
        return;
    }
    try { fs.unlinkSync(rawAttachment.path); } catch { /* ignore */ }

    // The emitted (task-lib-escaped) name, once unescaped, must be the RAW input.
    const decoded = unescapeCommandValue(rawAttachment.name);
    if (decoded !== rawName) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsRawNameCompatL0: legacy attachment name was not passed raw. Expected (decoded) ${JSON.stringify(rawName)}, got ${JSON.stringify(decoded)} (raw emitted: ${JSON.stringify(rawAttachment.name)}).`);
        return;
    }

    // And it must NOT have been sanitized (stripped) -- guards against a
    // regression that re-wraps the legacy name in sanitizeAttachmentName().
    if (rawAttachment.name === strippedName || decoded === strippedName) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsRawNameCompatL0: legacy attachment name was sanitized/stripped to ${JSON.stringify(strippedName)} instead of passed raw.`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanPublishResultsRawNameCompatL0 should have succeeded.');
}

void run();
