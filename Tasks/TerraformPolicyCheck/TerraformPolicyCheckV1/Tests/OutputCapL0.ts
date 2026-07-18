import * as assert from 'assert';
import { EventEmitter } from 'events';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { attachBoundedCapture, MAX_CAPTURED_OUTPUT_BYTES } from '../src/output-cap';

/**
 * Direct unit tests for attachBoundedCapture (#632) — the byte-bounded stdout/
 * stderr capture the OPA and Sentinel engines use instead of an unbounded
 * `stdout += chunk`. On a stdout breach the child is killed and assertWithinCap()
 * throws, so a huge or misbehaving engine output fails the task with a clear
 * error rather than OOMing the agent or being parsed as a truncated result.
 */

/** Fake ToolRunner that emits scripted chunks when execAsync() is invoked. */
class FakeTool extends EventEmitter {
    public killed = false;
    public killSignal: string | number | undefined;
    constructor(private readonly chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>) { super(); }
    killChildProcess(signal?: string | number): void {
        this.killed = true;
        this.killSignal = signal;
    }
    async run(): Promise<void> {
        for (const c of this.chunks) {
            this.emit(c.stream, c.data);
        }
    }
}

function asTool(fake: FakeTool): ToolRunner {
    return fake as unknown as ToolRunner;
}

describe('attachBoundedCapture — bounded engine output (#632)', function () {
    it('delivers all chunks to the sink and does not throw when under the cap', async () => {
        const fake = new FakeTool([
            { stream: 'stdout', data: '{"result":' },
            { stream: 'stdout', data: '[]}' },
            { stream: 'stderr', data: 'note' },
        ]);
        let stdout = '';
        let stderr = '';
        const capture = attachBoundedCapture(asTool(fake), (stream, text) => {
            if (stream === 'stdout') stdout += text; else stderr += text;
        });
        await fake.run();
        assert.doesNotThrow(() => capture.assertWithinCap());
        assert.strictEqual(stdout, '{"result":[]}');
        assert.strictEqual(stderr, 'note');
        assert.strictEqual(fake.killed, false);
    });

    it('kills the child and throws from assertWithinCap when stdout exceeds the cap', async () => {
        const fake = new FakeTool([
            { stream: 'stdout', data: 'aaaaaa' }, // 6 — under the 10-byte cap
            { stream: 'stdout', data: 'bbbbbb' }, // 12 — breaches the cap
            { stream: 'stdout', data: 'cccccc' }, // dropped: already in overflow
        ]);
        let stdout = '';
        const capture = attachBoundedCapture(asTool(fake), (_stream, text) => { stdout += text; }, 10);
        await fake.run();
        assert.strictEqual(fake.killed, true, 'the child must be killed on breach');
        assert.strictEqual(fake.killSignal, 'SIGKILL');
        assert.ok(!stdout.includes('cccccc'), 'no stdout is delivered once in overflow');
        assert.throws(() => capture.assertWithinCap(), /more than 10 bytes on stdout/);
    });

    it('bounds stderr without killing the child or failing the call', async () => {
        const fake = new FakeTool([
            { stream: 'stderr', data: 'aaaaaa' }, // 6
            { stream: 'stderr', data: 'bbbbbb' }, // 12 — over the 10-byte cap
            { stream: 'stderr', data: 'cccccc' }, // dropped
        ]);
        let stderr = '';
        const capture = attachBoundedCapture(asTool(fake), (_stream, text) => { stderr += text; }, 10);
        await fake.run();
        assert.doesNotThrow(() => capture.assertWithinCap());
        assert.ok(!stderr.includes('cccccc'), 'stderr stops accumulating past the cap');
        assert.strictEqual(fake.killed, false, 'stderr overflow must not kill the child');
    });

    it('exposes a generous production ceiling', () => {
        assert.strictEqual(MAX_CAPTURED_OUTPUT_BYTES, 100 * 1024 * 1024);
    });
});
