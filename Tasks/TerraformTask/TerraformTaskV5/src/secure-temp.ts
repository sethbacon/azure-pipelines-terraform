import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');

/**
 * Write sensitive content to a file with restrictive permissions.
 * Uses mode 0o600 on Unix; on Windows, falls back gracefully since
 * chmod is not supported and NTFS ACLs apply instead.
 */
export function writeSecretFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (err) {
        if (process.platform !== 'win32') {
            throw new Error(`Failed to set restrictive permissions on ${filePath}: ${err instanceof Error ? err.message : err}`);
        }
        tasks.debug('Skipping chmod on Windows platform (ACLs apply instead).');
    }
}
