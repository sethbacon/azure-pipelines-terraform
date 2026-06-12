import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';

/**
 * Resolves the directory containing the policies to evaluate.
 *
 * - `path`: a directory already on the agent (e.g. from an ADO multi-repo
 *   checkout). No credentials handled here.
 * - `gitUrl`: clones an HTTPS git repo at a ref into a temp dir (tracked in
 *   `tempDirs` for cleanup). A branch/tag is shallow-cloned; a full 40-char SHA
 *   is cloned then checked out. An optional token authenticates private repos
 *   via `http.extraheader` so it never appears in the clone URL.
 */
export async function resolvePolicyDir(tempDirs: string[]): Promise<string> {
    const source = tasks.getInput('policySource') || 'path';

    if (source === 'path') {
        const dir = path.resolve(tasks.getInput('policyPath', true)!);
        if (!fs.existsSync(dir)) {
            throw new Error(`Policy path does not exist: ${dir}`);
        }
        return dir;
    }

    // gitUrl
    const url = tasks.getInput('policyRepoUrl', true)!;
    if (!url.startsWith('https://')) {
        throw new Error(tasks.loc('InsecureUrlRejected', url));
    }
    const ref = tasks.getInput('policyRepoRef') || 'main';
    const subdir = tasks.getInput('policyRepoSubdir');
    const token = tasks.getInput('policyRepoToken');

    const cloneDir = path.join(os.tmpdir(), `policy-repo-${uuidV4()}`);
    await cloneRepo(url, ref, token, cloneDir);
    tempDirs.push(cloneDir);

    const policyDir = subdir ? path.join(cloneDir, subdir) : cloneDir;
    if (!fs.existsSync(policyDir)) {
        throw new Error(`Policy subdirectory does not exist in the cloned repo: ${policyDir}`);
    }
    return policyDir;
}

async function cloneRepo(url: string, ref: string, token: string | undefined, cloneDir: string): Promise<void> {
    const gitPath = tasks.which('git', true);
    const isSha = /^[0-9a-fA-F]{40}$/.test(ref);

    const authArgs: string[] = [];
    if (token) {
        tasks.setSecret(token);
        const header = `Authorization: Basic ${Buffer.from(`:${token}`).toString('base64')}`;
        tasks.setSecret(Buffer.from(`:${token}`).toString('base64'));
        authArgs.push('-c', `http.extraheader=${header}`);
    }

    if (isSha) {
        // Full clone (no checkout), then check out the exact commit.
        const clone = tasks.tool(gitPath);
        clone.arg(authArgs);
        clone.arg(['clone', '--no-checkout', url, cloneDir]);
        await clone.execAsync(<IExecOptions>{});

        const checkout = tasks.tool(gitPath);
        checkout.arg(['-C', cloneDir, 'checkout', ref]);
        await checkout.execAsync(<IExecOptions>{});
    } else {
        const clone = tasks.tool(gitPath);
        clone.arg(authArgs);
        clone.arg(['clone', '--depth', '1', '--branch', ref, url, cloneDir]);
        await clone.execAsync(<IExecOptions>{});
    }
}
