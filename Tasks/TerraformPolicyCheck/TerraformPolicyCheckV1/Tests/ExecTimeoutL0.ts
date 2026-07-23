import * as assert from 'assert';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { execWithTimeout, TOOL_EXEC_TIMEOUT_MS } from '../src/exec-timeout';

/**
 * Direct unit tests for execWithTimeout (#782) — the wall-clock deadline wrapper
 * that bounds the local policy-engine / terraform-docs subprocesses. On timeout
 * it kills the child and rejects with the supplied message; otherwise it returns
 * the tool's exit code unchanged (a non-zero code is a real outcome, not a hang).
 */

/** Fake ToolRunner whose execAsync resolution is controlled per-test. */
class FakeTool {
    public killed = false;
    constructor(private readonly behavior: () => Promise<number>) { }
    killChildProcess(): void { this.killed = true; }
    execAsync(_options?: IExecOptions): Promise<number> { return this.behavior(); }
}

function asTool(fake: FakeTool): ToolRunner {
    return fake as unknown as ToolRunner;
}

describe('execWithTimeout — bounded subprocess execution (#782)', function () {
    it('returns the tool exit code and never kills the child when it completes before the deadline', async () => {
        const fake = new FakeTool(async () => 0);
        const code = await execWithTimeout(asTool(fake), <IExecOptions>{}, 'should-not-fire', 10_000);
        assert.strictEqual(code, 0, 'should resolve with the tool exit code');
        assert.strictEqual(fake.killed, false, 'must not kill a child that finished in time');
    });

    it('propagates a non-zero exit code unchanged (does not conflate a policy-fail exit with a timeout)', async () => {
        const fake = new FakeTool(async () => 1);
        const code = await execWithTimeout(asTool(fake), <IExecOptions>{}, 'should-not-fire', 10_000);
        assert.strictEqual(code, 1);
        assert.strictEqual(fake.killed, false);
    });

    it('kills the child and rejects with the supplied message when the deadline is exceeded', async () => {
        // A child that never resolves; a tiny ceiling forces the deadline branch.
        const fake = new FakeTool(() => new Promise<number>(() => { /* never resolves */ }));
        await assert.rejects(
            execWithTimeout(asTool(fake), <IExecOptions>{}, 'engine-timed-out', 20),
            /engine-timed-out/,
        );
        assert.strictEqual(fake.killed, true, 'must kill the hung child on timeout');
    });

    it('propagates the underlying execAsync rejection (e.g. tool-not-found) without masking it as a timeout', async () => {
        const fake = new FakeTool(() => Promise.reject(new Error('spawn ENOENT')));
        await assert.rejects(
            execWithTimeout(asTool(fake), <IExecOptions>{}, 'should-not-be-the-reported-error', 10_000),
            /ENOENT/,
        );
        assert.strictEqual(fake.killed, false, 'a tool that failed on its own was never timed out');
    });

    it('exposes a positive default ceiling', function () {
        assert.ok(TOOL_EXEC_TIMEOUT_MS > 0, 'default ceiling should be a positive duration');
    });
});
