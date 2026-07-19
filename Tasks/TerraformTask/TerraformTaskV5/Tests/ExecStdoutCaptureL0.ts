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
    constructor(
        private readonly chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>,
        private readonly exitCode = 0,
    ) { super(); }
    killChildProcess(signal?: string | number): void {
        this.killed = true;
        this.killSignal = signal;
    }
    async execAsync(_options: IExecOptions): Promise<number> {
        // Emit synchronously to the listeners execWithStdoutCapture registered
        // before awaiting exec, then resolve with the scripted exit code.
        for (const c of this.chunks) {
            this.emit(c.stream, c.data);
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
