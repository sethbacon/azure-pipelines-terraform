import * as assert from 'assert';
import { EventEmitter } from 'events';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { BaseTerraformCommandHandler, MAX_CAPTURED_STDOUT_BYTES } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';

/**
 * Direct unit tests for execWithStdoutCapture's byte-count guard (#632). The
 * method is the single choke point plan/apply/destroy/show/output/refresh use
 * to buffer `terraform ... -json` stdout; without a ceiling an extremely large
 * plan/state or a misbehaving provider could grow one JS string until the task
 * OOMs. On breach the child is killed and the call throws a clear error rather
 * than returning a silently-truncated string that would be parsed into a digest.
 */

/** Minimal concrete handler exposing the protected capture method for testing. */
class TestHandler extends BaseTerraformCommandHandler {
    async handleBackend(): Promise<void> { /* no-op */ }
    async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> { /* no-op */ }
    async configureBackendCredentials(): Promise<void> { /* no-op */ }
    public capture(tool: ToolRunner, options: IExecOptions, max?: number) {
        return this.execWithStdoutCapture(tool, options, max as number);
    }
}

/** Fake ToolRunner that emits scripted chunks when execAsync is called. */
class FakeTool extends EventEmitter {
    public killed = false;
    public killSignal: string | number | undefined;
    public lastExecOptions: IExecOptions | undefined;
    constructor(
        private readonly chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>,
        private readonly exitCode = 0,
        // When set, execAsync rejects with this error AFTER emitting the chunks
        // -- models a non-ignoreReturnCode caller's non-zero exit (or a spawn
        // failure), where the real ToolRunner rejects instead of resolving.
        private readonly rejectWith?: Error,
    ) { super(); }
    killChildProcess(signal?: string | number): void {
        this.killed = true;
        this.killSignal = signal;
    }
    async execAsync(options: IExecOptions): Promise<number> {
        this.lastExecOptions = options;
        // Emit synchronously to the listeners execWithStdoutCapture registered
        // before awaiting exec, then resolve with the scripted exit code.
        for (const c of this.chunks) {
            this.emit(c.stream, c.data);
        }
        if (this.rejectWith) {
            throw this.rejectWith;
        }
        return this.exitCode;
    }
}

function asTool(fake: FakeTool): ToolRunner {
    return fake as unknown as ToolRunner;
}

describe('execWithStdoutCapture — bounded stdout capture (#632)', function () {
    it('returns the full stdout, stderr, and exit code when under the cap', async () => {
        const fake = new FakeTool([
            { stream: 'stdout', data: 'hello ' },
            { stream: 'stdout', data: 'world' },
            { stream: 'stderr', data: 'a warning' },
        ], 0);
        const result = await new TestHandler().capture(asTool(fake), {} as IExecOptions);
        assert.strictEqual(result.stdout, 'hello world');
        assert.strictEqual(result.stderr, 'a warning');
        assert.strictEqual(result.code, 0);
        assert.strictEqual(fake.killed, false, 'the child must not be killed on the normal path');
    });

    it('kills the child and throws when stdout exceeds the cap, without returning truncated output', async () => {
        const fake = new FakeTool([
            { stream: 'stdout', data: 'aaaaaa' }, // 6 bytes — under the 10-byte cap
            { stream: 'stdout', data: 'bbbbbb' }, // total 12 — breaches the cap
            { stream: 'stdout', data: 'cccccc' }, // dropped: already in overflow
        ], 0);
        await assert.rejects(
            () => new TestHandler().capture(asTool(fake), {} as IExecOptions, 10),
            /more than 10 bytes on stdout/,
        );
        assert.strictEqual(fake.killed, true, 'the child process must be killed on breach');
        assert.strictEqual(fake.killSignal, 'SIGKILL');
    });

    it('bounds stderr too but does not fail the call (stderr is diagnostic)', async () => {
        const fake = new FakeTool([
            { stream: 'stderr', data: 'aaaaaa' }, // 6
            { stream: 'stderr', data: 'bbbbbb' }, // 12 — over the 10-byte cap
            { stream: 'stderr', data: 'cccccc' }, // dropped: cap already exceeded
        ], 3);
        const result = await new TestHandler().capture(asTool(fake), {} as IExecOptions, 10);
        assert.strictEqual(result.code, 3, 'a stderr-heavy run still returns its exit code');
        assert.ok(!result.stderr.includes('cccccc'), 'stderr must stop accumulating past the cap');
        assert.strictEqual(fake.killed, false, 'stderr overflow must not kill the child or fail the call');
    });

    it('exposes a generous production ceiling', () => {
        assert.strictEqual(MAX_CAPTURED_STDOUT_BYTES, 100 * 1024 * 1024);
    });
});

/**
 * #492 (reopened): the capture primitive must FORCE `silent: true` on every
 * exec. Captured streams are routinely cleartext-sensitive (`output -json` /
 * `show -json` print `sensitive = true` values verbatim) and setSecret
 * registration happens only after the capture resolves, so an echoed line can
 * never be masked. Enforcing it here -- rather than at each call site -- is
 * what keeps a future caller from reopening the issue a third time. And
 * because silencing suppresses terraform's own stderr echo, a rejected exec
 * (non-ignoreReturnCode caller, non-zero exit) must fold the captured stderr
 * into the rethrown error or the failure's cause is swallowed (#613).
 */
describe('execWithStdoutCapture — forced-silent capture (#492) and stderr surfacing (#613)', function () {
    it('forces silent:true when the caller passes no silent option', async () => {
        const fake = new FakeTool([{ stream: 'stdout', data: '{"db_password":{"value":"hunter2","sensitive":true}}' }], 0);
        await new TestHandler().capture(asTool(fake), {} as IExecOptions);
        assert.strictEqual(fake.lastExecOptions?.silent, true, 'the exec options must carry silent:true');
    });

    it('overrides an explicit silent:false from the caller (forced, not defaulted)', async () => {
        const fake = new FakeTool([{ stream: 'stdout', data: 'x' }], 0);
        await new TestHandler().capture(asTool(fake), { silent: false } as IExecOptions);
        assert.strictEqual(fake.lastExecOptions?.silent, true, 'a caller must not be able to re-enable the echo');
    });

    it('still returns the captured streams unchanged under forced silence', async () => {
        const fake = new FakeTool([
            { stream: 'stdout', data: 'captured out' },
            { stream: 'stderr', data: 'captured err' },
        ], 2);
        const result = await new TestHandler().capture(asTool(fake), {} as IExecOptions);
        assert.strictEqual(result.stdout, 'captured out');
        assert.strictEqual(result.stderr, 'captured err');
        assert.strictEqual(result.code, 2);
    });

    it('folds captured stderr into the error when exec rejects', async () => {
        const fake = new FakeTool(
            [{ stream: 'stderr', data: 'Error: Too many command line arguments\n' }],
            1,
            new Error("The process 'terraform' failed with exit code 1"),
        );
        await assert.rejects(
            () => new TestHandler().capture(asTool(fake), {} as IExecOptions),
            (err: Error) => {
                assert.ok(err.message.includes("failed with exit code 1"), 'must keep the original failure message');
                assert.ok(err.message.includes('Too many command line arguments'), 'must surface the captured stderr');
                return true;
            },
        );
    });

    it('keeps the plain error when exec rejects and stderr is empty', async () => {
        const fake = new FakeTool([], 1, new Error("The process 'terraform' failed with exit code 1"));
        await assert.rejects(
            () => new TestHandler().capture(asTool(fake), {} as IExecOptions),
            /failed with exit code 1$/,
        );
    });

    it('reports the overflow (not the generic rejection) when the kill makes exec reject', async () => {
        const fake = new FakeTool(
            [{ stream: 'stdout', data: 'aaaaaaaaaaaa' }], // 12 bytes — breaches the 10-byte cap
            1,
            new Error("The process 'terraform' was killed"),
        );
        await assert.rejects(
            () => new TestHandler().capture(asTool(fake), {} as IExecOptions, 10),
            /more than 10 bytes on stdout/,
        );
        assert.strictEqual(fake.killed, true);
    });
});
