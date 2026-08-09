import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import tasks = require('azure-pipelines-task-lib/task');
import { isTransientGitFailure, GitCommandError, attemptClone, cloneWithRetry } from '../src/policy-source';

/**
 * CLASS TEST — network-retry coverage, git-clone half (#891; see
 * NetworkRetryClassL0.ts in TerraformInstallerV1 for the fetch/download half
 * of this same defect class, #879).
 *
 * Defect class: a network operation that can fail transiently is issued
 * without the repo's shared retry wrapper, while sibling operations in the
 * same module use it. cloneRepo's git clone was the one network operation in
 * this task with no retry at all.
 *
 * Table A: isTransientGitFailure's classification of real git stderr text --
 * the safety-critical piece (must never retry an authentication failure or a
 * genuine ref/repository-not-found error).
 * Table B: attemptClone's failure classification, via a FakeGitTool stubbed in
 * for tasks.tool() (mirrors the FakeTool pattern already used by
 * ExecTimeoutL0.ts / OutputCapL0.ts in this same task).
 * Table C: cloneWithRetry's end-to-end wiring -- retries a transient failure,
 * cleans the destination between attempts (never before the first), and never
 * retries a non-transient failure.
 */

/** Fake ToolRunner whose execAsync behavior and stderr emission are scripted per test. */
class FakeGitTool extends EventEmitter {
    public killed = false;
    public argsSeen: string[] = [];
    constructor(private readonly behavior: () => Promise<number>) {
        super();
    }
    arg(a: string | string[]): void {
        this.argsSeen.push(...(Array.isArray(a) ? a : [a]));
    }
    killChildProcess(): void {
        this.killed = true;
    }
    execAsync(): Promise<number> {
        return this.behavior();
    }
}

function asTool(fake: FakeGitTool): ToolRunner {
    return fake as unknown as ToolRunner;
}

/** Swaps tasks.tool() for the duration of `run`, always restoring it afterward. */
async function withStubbedTool<T>(factory: () => ToolRunner, run: () => Promise<T>): Promise<T> {
    const toolModule = tasks as unknown as { tool: (toolPath: string) => ToolRunner };
    const original = toolModule.tool;
    toolModule.tool = factory;
    try {
        return await run();
    } finally {
        toolModule.tool = original;
    }
}

describe('git-clone retry coverage (class test #891)', function () {
    this.timeout(10000);

    describe('A. isTransientGitFailure classification', () => {
        const ROWS: Array<{ what: string; stderr: string; transient: boolean }> = [
            { what: 'authentication failure', stderr: 'fatal: Authentication failed for https://example.com/repo.git', transient: false },
            { what: 'terminal-prompt username block', stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled", transient: false },
            { what: 'invalid username or password', stderr: 'remote: Invalid username or password.', transient: false },
            { what: 'a 401 from the smart-HTTP endpoint', stderr: "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 401", transient: false },
            { what: 'a 404 from the smart-HTTP endpoint', stderr: "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 404", transient: false },
            { what: 'remote branch not found', stderr: 'fatal: Remote branch nonexistent not found in upstream origin', transient: false },
            { what: "couldn't find remote ref", stderr: "fatal: couldn't find remote ref refs/heads/nonexistent", transient: false },
            { what: 'repository not found', stderr: 'remote: Repository not found.', transient: false },
            { what: 'connection reset (transient)', stderr: 'error: RPC failed; curl 56 Recv failure: Connection reset by peer', transient: true },
            { what: 'could not resolve host (transient)', stderr: "fatal: unable to access 'https://example.com/': Could not resolve host: example.com", transient: true },
            { what: 'a 503 from the smart-HTTP endpoint (transient)', stderr: "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 503", transient: true },
            { what: 'remote end hung up unexpectedly (transient)', stderr: 'fatal: the remote end hung up unexpectedly', transient: true },
            { what: 'empty stderr, e.g. a hard timeout kill (transient)', stderr: '', transient: true },
        ];
        for (const row of ROWS) {
            it(`classifies ${row.what} as ${row.transient ? 'transient (retry)' : 'NON-transient (never retry)'}`, () => {
                assert.strictEqual(isTransientGitFailure(row.stderr), row.transient);
            });
        }
    });

    describe('B. attemptClone: failure classification', () => {
        let tmpRoot: string;
        let cloneDir: string;
        beforeEach(() => {
            // Atomically-created unique root (the sibling suites' idiom); cloneDir is a
            // path INSIDE it that must not exist yet, since that is what git clones into.
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-clone-retry-'));
            cloneDir = path.join(tmpRoot, 'repo');
        });
        afterEach(() => {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        });

        it('throws a GitCommandError(retryable=false) for an authentication failure', async () => {
            await assert.rejects(
                withStubbedTool(
                    () => {
                        const fake = new FakeGitTool(async () => {
                            fake.emit('stderr', 'fatal: Authentication failed for https://example.com/repo.git\n');
                            throw new Error('git failed with return code: 128');
                        });
                        return asTool(fake);
                    },
                    () => attemptClone('/usr/bin/git', ['clone', '--', 'https://example.com/repo.git', cloneDir], {}),
                ),
                (err: unknown) => {
                    assert.ok(err instanceof GitCommandError, 'must be a GitCommandError');
                    assert.strictEqual((err as GitCommandError).retryable, false, 'an authentication failure must be classified non-retryable');
                    return true;
                },
            );
        });

        it('throws a GitCommandError(retryable=true) for a transient network failure', async () => {
            await assert.rejects(
                withStubbedTool(
                    () => {
                        const fake = new FakeGitTool(async () => {
                            fake.emit('stderr', 'error: RPC failed; curl 56 Recv failure: Connection reset by peer\n');
                            throw new Error('git failed with return code: 128');
                        });
                        return asTool(fake);
                    },
                    () => attemptClone('/usr/bin/git', ['clone', '--', 'https://example.com/repo.git', cloneDir], {}),
                ),
                (err: unknown) => {
                    assert.ok(err instanceof GitCommandError, 'must be a GitCommandError');
                    assert.strictEqual((err as GitCommandError).retryable, true, 'a transient connection failure must be classified retryable');
                    return true;
                },
            );
        });
    });

    describe('C. cloneWithRetry: end-to-end retry wiring', () => {
        let tmpRoot: string;
        let cloneDir: string;
        beforeEach(() => {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-clone-retry-e2e-'));
            cloneDir = path.join(tmpRoot, 'repo');
        });
        afterEach(() => {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        });

        it('retries a transient failure and succeeds on a later attempt', async () => {
            let attempts = 0;
            await withStubbedTool(
                () => {
                    attempts++;
                    const thisAttempt = attempts;
                    const fake = new FakeGitTool(async () => {
                        if (thisAttempt < 3) {
                            fake.emit('stderr', 'fatal: the remote end hung up unexpectedly\n');
                            throw new Error('git failed with return code: 128');
                        }
                        return 0;
                    });
                    return asTool(fake);
                },
                () => cloneWithRetry('/usr/bin/git', ['clone', '--', 'https://example.com/repo.git', cloneDir], {}, cloneDir),
            );
            assert.strictEqual(attempts, 3, 'expected 2 failed attempts then a 3rd that succeeds');
        });

        it('removes whatever a failed attempt left behind before retrying, never before the first attempt', async () => {
            fs.mkdirSync(cloneDir, { recursive: true });
            const preExisting = path.join(cloneDir, 'unrelated-pre-test-marker.txt');
            fs.writeFileSync(preExisting, 'present before the first attempt runs at all');
            let sawOnFirstAttempt = 'unknown';
            let sawOnSecondAttempt = 'unknown';
            let attempts = 0;
            await withStubbedTool(
                () => {
                    attempts++;
                    const thisAttempt = attempts;
                    const fake = new FakeGitTool(async () => {
                        if (thisAttempt === 1) {
                            sawOnFirstAttempt = fs.existsSync(preExisting) ? 'exists' : 'absent';
                            fs.writeFileSync(path.join(cloneDir, 'partial-from-attempt-1.txt'), 'stale');
                            fake.emit('stderr', 'fatal: the remote end hung up unexpectedly\n');
                            throw new Error('git failed with return code: 128');
                        }
                        sawOnSecondAttempt = fs.existsSync(path.join(cloneDir, 'partial-from-attempt-1.txt')) ? 'exists' : 'absent';
                        return 0;
                    });
                    return asTool(fake);
                },
                () => cloneWithRetry('/usr/bin/git', ['clone', '--', 'https://example.com/repo.git', cloneDir], {}, cloneDir),
            );
            assert.strictEqual(sawOnFirstAttempt, 'exists', 'the very first attempt must NOT have cloneDir pre-emptively wiped (nothing to clean yet)');
            assert.strictEqual(sawOnSecondAttempt, 'absent', 'the retry must start from a clean destination, with the failed first attempt\'s partial content removed');
        });

        it('never retries a non-transient (authentication) failure', async () => {
            let attempts = 0;
            await assert.rejects(
                withStubbedTool(
                    () => {
                        attempts++;
                        const fake = new FakeGitTool(async () => {
                            fake.emit('stderr', 'fatal: Authentication failed for https://example.com/repo.git\n');
                            throw new Error('git failed with return code: 128');
                        });
                        return asTool(fake);
                    },
                    () => cloneWithRetry('/usr/bin/git', ['clone', '--', 'https://example.com/repo.git', cloneDir], {}, cloneDir),
                ),
                /git failed with return code: 128/,
            );
            assert.strictEqual(attempts, 1, 'an authentication failure must never be retried');
        });

        it('never retries a genuine ref-not-found failure', async () => {
            let attempts = 0;
            await assert.rejects(
                withStubbedTool(
                    () => {
                        attempts++;
                        const fake = new FakeGitTool(async () => {
                            fake.emit('stderr', 'fatal: Remote branch nonexistent not found in upstream origin\n');
                            throw new Error('git failed with return code: 128');
                        });
                        return asTool(fake);
                    },
                    () => cloneWithRetry('/usr/bin/git', ['clone', '--branch', 'nonexistent', '--', 'https://example.com/repo.git', cloneDir], {}, cloneDir),
                ),
                /git failed with return code: 128/,
            );
            assert.strictEqual(attempts, 1, 'a genuine ref-not-found error must never be retried');
        });

        it('gives up after exhausting all attempts on a persistent transient failure', async () => {
            let attempts = 0;
            await assert.rejects(
                withStubbedTool(
                    () => {
                        attempts++;
                        const fake = new FakeGitTool(async () => {
                            fake.emit('stderr', 'fatal: the remote end hung up unexpectedly\n');
                            throw new Error('git failed with return code: 128');
                        });
                        return asTool(fake);
                    },
                    () => cloneWithRetry('/usr/bin/git', ['clone', '--', 'https://example.com/repo.git', cloneDir], {}, cloneDir),
                ),
                /git failed with return code: 128/,
            );
            assert.strictEqual(attempts, 3, 'total attempts = retries + 1, matching CLONE_RETRY_ATTEMPTS');
        });
    });
});
