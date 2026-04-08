import tasks = require('azure-pipelines-task-lib/task');

export interface ISecureFileLoader {
    downloadSecureFile(secureFileId: string): Promise<string>;
    deleteSecureFile(secureFileId: string): void;
}

/**
 * Downloads a secure file from the ADO Secure Files library and returns its temp path.
 * Wraps azure-pipelines-tasks-securefiles-common for mockability.
 */
export class SecureFileLoader implements ISecureFileLoader {
    private helpers: any;

    constructor() {
        const { SecureFileHelpers } = require('azure-pipelines-tasks-securefiles-common/securefiles-common');
        this.helpers = new SecureFileHelpers();
    }

    public async downloadSecureFile(secureFileId: string): Promise<string> {
        tasks.debug(`Downloading secure file: ${secureFileId}`);
        const filePath = await this.helpers.downloadSecureFile(secureFileId);
        tasks.debug(`Secure file downloaded to: ${filePath}`);
        return filePath;
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
