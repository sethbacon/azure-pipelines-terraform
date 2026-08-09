import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions, ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { retryAsync } from './retry';
import { attachBoundedCapture } from './output-cap';

// Wall-clock bound for each git invocation. git's HTTP transport has no built-in
// connect/idle timeout, so an unreachable, slow, or credential-prompting host
// would otherwise hang until the ADO job timeout.
const GIT_TIMEOUT_MS = 300_000;

// Bounded retry for the git-clone network operation (#891): mirrors
// http-client.ts's RETRY_ATTEMPTS/RETRY_BASE_MS policy (3 total attempts,
// 200ms base) so this task's one network operation gets the same resilience
// to a transient blip that every retried HTTP call elsewhere in the repo has.
const CLONE_RETRY_ATTEMPTS = 3;
const CLONE_RETRY_BASE_MS = 200;

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
 *   via an `http.extraheader` Authorization header, delivered as per-invocation
 *   `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment variables (git >= 2.31)
 *   rather than a `-c http.extraheader=...` argv item, so the token never
 *   appears in the clone URL or in the child process's command line (readable
 *   via ps / /proc/<pid>/cmdline by other processes on a shared agent).
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

    // Agent.TempDirectory is auto-purged by the ADO agent at job end, which
    // backstops cleanup even if the process is killed (e.g. a cancelled build)
    // before the try/finally in index.ts can run fs.rmSync -- os.tmpdir() has
    // no such guarantee and would otherwise need its own SIGTERM/SIGINT
    // handler to avoid leaking a clone on cancellation.
    const cloneDir = path.join(tasks.getVariable('Agent.TempDirectory') || os.tmpdir(), `policy-repo-${uuidV4()}`);
    tempDirs.push(cloneDir);
    await cloneRepo(url, ref, token, cloneDir);

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

/**
 * Builds the per-invocation git config ENV VARS (git >= 2.31) that carry the
 * clone credential for a private policy repo.
 *
 * - The Authorization header is delivered via `GIT_CONFIG_*` env rather than a
 *   `-c http.extraheader=...` argv item, so the token never appears in the child
 *   process's command line (readable via ps / /proc/<pid>/cmdline by other
 *   processes on a shared agent).
 * - `http.followRedirects` is disabled (#779): git applies `http.extraheader` to
 *   EVERY HTTP request and, with the default `followRedirects=initial`, re-sends
 *   that header when the initial smart-HTTP request is redirected to a DIFFERENT
 *   host. Because the header is not host-scoped, a `policyRepoUrl` pointed at a
 *   host that issues a cross-host redirect would otherwise forward the
 *   `Authorization: Basic <PAT>` to the redirect target. Disabling redirect
 *   following for the authenticated clone keeps the credential pinned to the
 *   originally-configured host. (Unauthenticated clones never call this and keep
 *   git's default redirect behavior — there is no credential to protect.)
 */
export function buildGitAuthEnv(basic: string): Record<string, string> {
    return {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        GIT_CONFIG_KEY_1: 'http.followRedirects',
        GIT_CONFIG_VALUE_1: 'false',
    };
}

async function cloneRepo(url: string, ref: string, token: string | undefined, cloneDir: string): Promise<void> {
    const gitPath = tasks.which('git', true);
    const isSha = /^[0-9a-fA-F]{40}$/.test(ref);

    const authEnv: Record<string, string> = {};
    if (token) {
        tasks.setSecret(token);
        const basic = Buffer.from(`:${token}`).toString('base64');
        tasks.setSecret(basic);
        Object.assign(authEnv, buildGitAuthEnv(basic));
    }

    // `--` stops git option-parsing before the url/dir positionals; for the SHA
    // path `ref` is validated 40-char hex so the later checkout positional is
    // safe, and for the branch/tag path `ref` is the `--branch` value and is
    // constrained by SAFE_REF (no leading dash).
    const cloneArgs = isSha
        ? ['clone', '--no-checkout', '--', url, cloneDir]
        : ['clone', '--depth', '1', '--branch', ref, '--', url, cloneDir];
    await cloneWithRetry(gitPath, cloneArgs, authEnv, cloneDir);

    if (isSha) {
        // Local checkout of the already-fetched objects -- no network I/O, so
        // (unlike the clone above) there is nothing transient to retry here;
        // a failure is deterministic (e.g. a bad/unreachable SHA).
        const checkout = tasks.tool(gitPath);
        checkout.arg(['-C', cloneDir, 'checkout', ref]);
        await execGit(checkout);
    }
}

/**
 * Non-retryable git failure signatures (#891): an authentication failure or a
 * genuine "ref/repository does not exist" are deterministic outcomes, not
 * transient network conditions, so they must never be retried as if they
 * were -- that would waste the retry budget repeating the same guaranteed
 * failure. Matched against captured stderr text (see attemptClone below).
 * Deliberately a narrow, well-known deny-list rather than an allow-list of
 * "known transient" patterns: git's transient-failure wording (connection
 * reset, DNS failure, TLS handshake errors, a mid-transfer disconnect, a
 * 5xx from the smart-HTTP endpoint) is too varied to enumerate exhaustively,
 * so anything NOT matched here is treated as transient and retried --
 * mirroring http-client.ts's own "a non-HttpError is transient" default.
 */
const NON_TRANSIENT_GIT_PATTERNS: RegExp[] = [
    /authentication failed/i,
    /could not read username/i,
    /could not read password/i,
    /invalid username or password/i,
    /the requested url returned error: 4\d\d/i, // a 4xx from the smart-HTTP endpoint (401/403/404/...)
    /remote branch .* not found in upstream/i,
    /couldn'?t find remote ref/i,
    /repository not found/i,
];

export function isTransientGitFailure(stderr: string): boolean {
    return !NON_TRANSIENT_GIT_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** Carries whether a git-clone failure is worth retrying; see NON_TRANSIENT_GIT_PATTERNS. */
export class GitCommandError extends Error {
    constructor(message: string, readonly retryable: boolean) {
        super(message);
        this.name = 'GitCommandError';
    }
}

/**
 * Runs `git clone` with bounded retry (#891). The clone is the one network
 * operation this task performs, and a transient failure partway through used
 * to fail the whole policy check with no second try, unlike every retried
 * HTTP call elsewhere in this repo. Only a genuinely transient failure is
 * retried: stderr is captured (without disabling the normal live echo, via
 * output-cap.ts's attachBoundedCapture) purely to classify the failure, and
 * an authentication failure or a real "ref/repository not found" is never
 * retried (see NON_TRANSIENT_GIT_PATTERNS). Between attempts, onRetry clears
 * cloneDir: git refuses to clone into a non-empty existing directory, so a
 * retry must remove whatever the failed attempt partially wrote before trying
 * again -- exactly the same "clean destination state per attempt" discipline
 * applied to the installer family's downloadToFile (#879). The very first
 * attempt is left untouched (cloneDir is always a fresh uuid-per-invocation
 * path with nothing to clean yet).
 */
export async function cloneWithRetry(gitPath: string, cloneArgs: string[], authEnv: Record<string, string>, cloneDir: string): Promise<void> {
    await retryAsync(() => attemptClone(gitPath, cloneArgs, authEnv), {
        retries: CLONE_RETRY_ATTEMPTS - 1,
        baseDelayMs: CLONE_RETRY_BASE_MS,
        retryError: (err) => (err instanceof GitCommandError ? err.retryable : true),
        onRetry: (attempt, _delayMs, outcome) => {
            const err = outcome.kind === 'error' ? outcome.error : undefined;
            tasks.debug(`git clone attempt ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}); retrying...`);
            // git refuses to clone into a non-empty existing directory -- clear
            // whatever the failed attempt just left behind before the next one
            // starts, so a retry begins from a clean, empty destination instead
            // of erroring on "already exists and is not empty" and masking the
            // real (retryable) failure underneath it. Deliberately NOT done
            // before the very first attempt: cloneDir is always a fresh
            // uuid-per-invocation path that has never been written to yet, and
            // pre-emptively removing it there has no purpose beyond the first
            // attempt.
            fs.rmSync(cloneDir, { recursive: true, force: true });
        },
    });
}

export async function attemptClone(gitPath: string, cloneArgs: string[], authEnv: Record<string, string>): Promise<void> {
    const tool = tasks.tool(gitPath);
    tool.arg(cloneArgs);
    let stderr = '';
    attachBoundedCapture(tool, (stream, text) => {
        if (stream === 'stderr') stderr += text;
    });
    try {
        await execGit(tool, authEnv);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GitCommandError(message, isTransientGitFailure(stderr));
    }
}

/**
 * Runs a git ToolRunner with a hard wall-clock timeout and a fail-fast
 * environment (never prompt for credentials; abort a stalled HTTP transfer).
 */
async function execGit(tool: ToolRunner, extraEnv: Record<string, string> = {}): Promise<void> {
    const options = <IExecOptions>{
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_HTTP_LOW_SPEED_LIMIT: '1000',
            GIT_HTTP_LOW_SPEED_TIME: '60',
            ...extraEnv,
        }
    };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            tool.killChildProcess('SIGKILL');
            reject(new Error(tasks.loc('PolicyRepoCloneTimedOut', GIT_TIMEOUT_MS)));
        }, GIT_TIMEOUT_MS);
    });
    // If the deadline wins the race, killChildProcess() makes this promise reject
    // later; attach a no-op catch so that late rejection is swallowed intentionally
    // rather than surfacing as an unhandled promise rejection (this task has no
    // process-level unhandledRejection handler).
    const exec = tool.execAsync(options);
    exec.catch(() => { /* swallowed: the timeout is reported via the deadline branch */ });
    try {
        await Promise.race([exec, deadline]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
