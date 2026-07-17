import { ParentCommandHandler } from './../../../src/parent-handler';
import tl = require('azure-pipelines-task-lib');
import fs = require('fs');

/**
 * Covers #547: the legacy publishPlanResults raw-plan attachment carries the
 * human-readable `terraform plan` stdout, which can include
 * non-sensitive-but-secret resource attributes. It must be written through
 * the 0600 secret-file primitive (writeSecretFile) instead of a plain
 * default-umask writeFileSync. This test runs the full plan path, extracts
 * the attachment path from the emitted ##vso[task.addattachment] command, and
 * asserts the on-disk file's restrictive mode (Unix only — on Windows the
 * primitive applies a DACL instead, covered by SecureTempL0).
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
        tl.setResult(tl.TaskResult.Failed, 'AzurePlanPublishResultsAttachmentPermissionsL0: no addattachment command emitted.');
        return;
    }

    const attachmentPath = match[1].trim();
    try {
        if (!fs.existsSync(attachmentPath)) {
            tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsAttachmentPermissionsL0: attachment file missing: ${attachmentPath}`);
            return;
        }
        if (process.platform !== 'win32' && (fs.statSync(attachmentPath).mode & 0o777) !== 0o600) {
            tl.setResult(tl.TaskResult.Failed, `AzurePlanPublishResultsAttachmentPermissionsL0: attachment file is not 0600: ${(fs.statSync(attachmentPath).mode & 0o777).toString(8)}`);
            return;
        }
        tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanPublishResultsAttachmentPermissionsL0 should have succeeded.');
    } finally {
        // Clean up after ourselves so the test does not leak the temp file.
        try { fs.unlinkSync(attachmentPath); } catch { /* ignore */ }
    }
}

void run();
