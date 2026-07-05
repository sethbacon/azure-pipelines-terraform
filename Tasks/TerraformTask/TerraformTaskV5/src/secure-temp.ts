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

/**
 * Chmods an existing file to 0600 after the fact. Unlike writeSecretFile
 * (which controls the initial write), this is for files this task did not
 * write itself -- e.g. a secure file downloaded by the third-party
 * azure-pipelines-tasks-securefiles-common helper, which applies its own
 * (often less restrictive) default permissions.
 */
export function tightenFilePermissions(filePath: string): void {
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (err) {
        if (process.platform !== 'win32') {
            throw new Error(`Failed to set restrictive permissions on ${filePath}: ${err instanceof Error ? err.message : err}`);
        }
        tasks.debug('Skipping chmod on Windows platform (ACLs apply instead).');
    }
}
