import tasks = require('azure-pipelines-task-lib/task');

export interface ISecureFileLoader {
    downloadSecureFile(secureFileId: string): Promise<string>;
    deleteSecureFile(secureFileId: string): void;
}

/**
 * Default bound on a Secure Files download. The vendored securefiles-common
 * helper performs the download with no socket timeout, so a stalled transfer
 * would otherwise hang the task indefinitely.
 */
export const DEFAULT_SECURE_FILE_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Downloads a secure file from the ADO Secure Files library and returns its temp path.
 * Wraps azure-pipelines-tasks-securefiles-common for mockability.
 */
export class SecureFileLoader implements ISecureFileLoader {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic require of untyped securefiles-common
    private helpers: any;
    private readonly timeoutMs: number;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional injection of the untyped securefiles-common helper for testing
    constructor(helpers?: any, timeoutMs: number = DEFAULT_SECURE_FILE_DOWNLOAD_TIMEOUT_MS) {
        this.timeoutMs = timeoutMs;
        if (helpers) {
            this.helpers = helpers;
            return;
        }
        const { SecureFileHelpers } = require('azure-pipelines-tasks-securefiles-common/securefiles-common');
        this.helpers = new SecureFileHelpers();
    }

    public async downloadSecureFile(secureFileId: string): Promise<string> {
        tasks.debug(`Downloading secure file: ${secureFileId}`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Secure file download timed out after ${this.timeoutMs}ms.`)),
                this.timeoutMs,
            );
        });
        try {
            const filePath = await Promise.race([this.helpers.downloadSecureFile(secureFileId), timeout]);
            tasks.debug(`Secure file downloaded to: ${filePath}`);
            return filePath;
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    public deleteSecureFile(secureFileId: string): void {
        try {
            this.helpers.deleteSecureFile(secureFileId);
            tasks.debug(`Deleted secure file: ${secureFileId}`);
        } catch (err) {
            tasks.debug(`Failed to delete secure file ${secureFileId}: ${err}`);
        }
    }
}

/**
 * If a secureVarsFile input is set, downloads it and returns `-var-file=<path>`.
 * Returns null if no secure file is configured.
 */
export async function getSecureVarFileArgs(loader?: ISecureFileLoader): Promise<{ varFileArg: string; secureFileId: string } | null> {
    const secureFileId = tasks.getInput("secureVarsFile", false);
    if (!secureFileId) {
        return null;
    }

    const secureFileLoader = loader || new SecureFileLoader();
    const filePath = await secureFileLoader.downloadSecureFile(secureFileId);
    return { varFileArg: `-var-file=${filePath}`, secureFileId };
}
