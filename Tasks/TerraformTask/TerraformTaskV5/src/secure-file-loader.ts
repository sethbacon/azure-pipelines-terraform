import tasks = require('azure-pipelines-task-lib/task');
import { scrubFile, tightenFilePermissions } from '@4cloudguru/pipeline-task-ado';
import { maskSecureVarFileValues } from './secure-var-file-masking';

export interface ISecureFileLoader {
    downloadSecureFile(secureFileId: string): Promise<string>;
    deleteSecureFile(secureFileId: string, filePath?: string): void;
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
        let timedOut = false;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => {
                    timedOut = true;
                    reject(new Error(`Secure file download timed out after ${this.timeoutMs}ms.`));
                },
                this.timeoutMs,
            );
        });
        const download = this.helpers.downloadSecureFile(secureFileId);
        // If the timeout wins the race, `download` keeps running unobserved. What
        // happens to it next falls into two cases, both handled on this SAME
        // promise (registered before the Promise.race below, so this callback
        // always runs first and observes `timedOut` as of just before this
        // resolution/rejection -- not mutated by it):
        //   - it eventually REJECTS: harmless, nothing was ever written to disk.
        //     A bare .catch() here just keeps this from surfacing as a process-
        //     level unhandledRejection and clobbering an already-reported task
        //     result -- mirroring the guard in TerraformPolicyCheck's
        //     policy-source.ts execGit().
        //   - it eventually RESOLVES: the vendored library finished writing a
        //     secret-bearing file (.pkrvars/.tfvars) to disk, at a path this
        //     function has already stopped tracking -- Promise.race only ever
        //     surfaces whichever settled FIRST (the timeout), so that path was
        //     never returned to any caller and would otherwise sit on disk,
        //     never scrubbed or deleted, until the agent's own temp-purge (if
        //     any). Only handled when `timedOut` is true: on the normal
        //     success path (download wins the race outright) this same .then()
        //     also fires, and must NOT delete the file the caller is about to
        //     receive and use.
        Promise.resolve(download).then(
            (latePath) => {
                if (!timedOut) return;
                tasks.warning(`Secure file ${secureFileId} finished downloading after its ${this.timeoutMs}ms timeout had already failed this step; deleting the orphaned file.`);
                this.deleteSecureFile(secureFileId, latePath);
            },
            () => { /* superseded by the timeout below -- nothing was written */ },
        );
        try {
            const filePath = await Promise.race([download, timeout]);
            // The secure file (which may carry secrets in a .pkrvars/.tfvars
            // file) is downloaded by the upstream library with its own
            // default (often 0644) permissions and never tightened.
            tightenFilePermissions(filePath);
            tasks.debug(`Secure file downloaded to: ${filePath}`);
            return filePath;
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    public deleteSecureFile(secureFileId: string, filePath?: string): void {
        try {
            // The secure var file (.tfvars/.pkrvars, commonly secret-bearing) is
            // about to be unlinked by the vendored helper. Scrub its bytes to zero
            // first (best-effort) so it gets the same overwrite-before-unlink
            // treatment as every other credential temp file (#662, #595); a bare
            // unlink leaves the bytes recoverable until overwritten.
            if (filePath) {
                try {
                    scrubFile(filePath);
                } catch (scrubErr) {
                    tasks.warning(`Failed to scrub secure file ${secureFileId} before deletion: ${scrubErr}`);
                }
            }
            this.helpers.deleteSecureFile(secureFileId);
            tasks.debug(`Deleted secure file: ${secureFileId}`);
        } catch (err) {
            // A leftover secure file (which can hold -var-file secrets) is a
            // real exposure on a self-hosted agent -- surface it above debug.
            tasks.warning(`Failed to delete secure file ${secureFileId}: ${err}`);
        }
    }
}

/**
 * If a secureVarsFile input is set, downloads it and returns `-var-file=<path>`.
 * Returns null if no secure file is configured. `filePath` is the resolved
 * download path, surfaced so the caller can scrub it before deletion (#662).
 */
export async function getSecureVarFileArgs(loader?: ISecureFileLoader): Promise<{ varFileArg: string; secureFileId: string; filePath: string } | null> {
    const secureFileId = tasks.getInput("secureVarsFile", false);
    if (!secureFileId) {
        return null;
    }

    const secureFileLoader = loader || new SecureFileLoader();
    const filePath = await secureFileLoader.downloadSecureFile(secureFileId);
    // task.json steers secrets into this file, but nothing ever registered its
    // CONTENTS with the masker -- only the file's permissions were tightened and
    // its bytes scrubbed at cleanup. Register every scalar string value BEFORE
    // the path reaches terraform, so a value terraform echoes (a diagnostic that
    // quotes the offending value, TF_LOG output) is masked.
    maskSecureVarFileValues(filePath);
    return { varFileArg: `-var-file=${filePath}`, secureFileId, filePath };
}
