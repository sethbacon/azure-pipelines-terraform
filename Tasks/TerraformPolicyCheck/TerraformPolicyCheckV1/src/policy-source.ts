import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions, ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';

// Wall-clock bound for each git invocation. git's HTTP transport has no built-in
// connect/idle timeout, so an unreachable, slow, or credential-prompting host
// would otherwise hang until the ADO job timeout.
const GIT_TIMEOUT_MS = 300_000;

// A git ref we are willing to hand to `git clone --branch` / `git checkout`.
// Rejects leading-dash refs (e.g. `--upload-pack=<cmd>`) and anything outside a
// conservative branch/tag/SHA charset, closing the argument-injection vector.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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
    if (!SAFE_REF.test(ref)) {
        throw new Error(tasks.loc('InvalidPolicyRepoRef', ref));
    }
    const subdir = tasks.getInput('policyRepoSubdir');
    const token = tasks.getInput('policyRepoToken');

    const cloneDir = path.join(os.tmpdir(), `policy-repo-${uuidV4()}`);
    await cloneRepo(url, ref, token, cloneDir);
    tempDirs.push(cloneDir);

    // Resolve the subdir against the clone root and assert containment, so a
    // `../../x` (or absolute) subdir cannot point the policy bundle at an
    // arbitrary readable directory on the agent.
    const policyDir = subdir ? path.resolve(cloneDir, subdir) : cloneDir;
    if (policyDir !== cloneDir && !policyDir.startsWith(cloneDir + path.sep)) {
        throw new Error(tasks.loc('PolicySubdirOutsideRepo', subdir));
    }
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
        // Full clone (no checkout), then check out the exact commit. `--` stops
        // git option-parsing before the url/dir positionals; `ref` is a
        // validated 40-char SHA here, so the checkout positional is safe.
        const clone = tasks.tool(gitPath);
        clone.arg(authArgs);
        clone.arg(['clone', '--no-checkout', '--', url, cloneDir]);
        await execGit(clone);

        const checkout = tasks.tool(gitPath);
        checkout.arg(['-C', cloneDir, 'checkout', ref]);
        await execGit(checkout);
    } else {
        // `--` stops option-parsing before url/dir; `ref` is the `--branch`
        // value and is constrained by SAFE_REF (no leading dash).
        const clone = tasks.tool(gitPath);
        clone.arg(authArgs);
        clone.arg(['clone', '--depth', '1', '--branch', ref, '--', url, cloneDir]);
        await execGit(clone);
    }
}

/**
 * Runs a git ToolRunner with a hard wall-clock timeout and a fail-fast
 * environment (never prompt for credentials; abort a stalled HTTP transfer).
 */
async function execGit(tool: ToolRunner): Promise<void> {
    const options = <IExecOptions>{
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_HTTP_LOW_SPEED_LIMIT: '1000',
            GIT_HTTP_LOW_SPEED_TIME: '60'
        }
    };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            tool.killChildProcess();
            reject(new Error(tasks.loc('PolicyRepoCloneTimedOut', GIT_TIMEOUT_MS)));
        }, GIT_TIMEOUT_MS);
    });
    try {
        await Promise.race([tool.execAsync(options), deadline]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
