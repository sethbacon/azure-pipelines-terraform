import { ParentCommandHandler } from './../../../src/parent-handler';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Regression test for the publishPlanResults attachment race.
 *
 * The agent uploads ##vso[task.addattachment] files asynchronously after reading
 * the command from stdout. If the task adds the attachment file to its own temp-file
 * cleanup list, cleanupTempFiles() (run in the finally of ParentCommandHandler.execute)
 * unlinks the file before the agent uploads it, producing "attachment file does not
 * exist on disk". This test runs the full execute() path (which performs cleanup) and
 * asserts the attachment file referenced by the emitted command still exists afterward.
 */
async function run(): Promise<void> {
    // Capture stdout to extract the ##vso[task.addattachment ...]<path> line.
    let captured = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any, ...args: any[]): boolean => {
        captured += chunk.toString();
        return (originalWrite as any)(chunk, ...args);
    };

    try {
        const handler = new ParentCommandHandler();
        await handler.execute('azurerm', 'plan');
    } finally {
        (process.stdout.write as any) = originalWrite;
    }

    const match = captured.match(/##vso\[task\.addattachment[^\]]*\](.+)/);
    if (!match) {
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanPublishResultsAttachmentSurvivesCleanupL0: no addattachment command emitted.');
        return;
    }

    const attachmentPath = match[1].trim();
    if (fs.existsSync(attachmentPath)) {
        // Clean up after ourselves so the test does not leak the temp file.
        try { fs.unlinkSync(attachmentPath); } catch { /* ignore */ }
        tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanPublishResultsAttachmentSurvivesCleanupL0 should have succeeded.');
    } else {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsAttachmentSurvivesCleanupL0: attachment file deleted before upload: ${attachmentPath}`);
    }
}

void run();
