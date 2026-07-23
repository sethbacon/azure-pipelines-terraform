import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');

/**
 * End-to-end coverage for src/index.ts's SIGTERM/SIGINT/uncaughtException/
 * unhandledRejection registration (#775): a pipeline cancellation mid-run must
 * scrub+delete the writeSecretFile'd summary file (which can hold sensitive plan
 * values) and then re-raise the signal. Unlike the normal-completion path (which
 * keeps the opt-in cleanupSummaryFile gate), the emergency path deletes the file
 * unconditionally -- on a cancellation there is no downstream step left to read
 * summaryFilePath.
 *
 * Follows TerraformTaskV5's SignalHandlerL0.ts approach: rather than a
 * cross-process spawn + child.kill (non-deterministic on Windows), drive the
 * REAL, unmodified index.ts in-process (reloaded fresh via the require cache each
 * test). run() is synchronous through writeSecretFile() and suspends at the first
 * await -- the callback POST -- so summarize() is stubbed (a fixed result) and
 * postJsonWithRetry is stubbed to never resolve (standing in for a TSM callback
 * still in flight when the signal arrives). process.kill / process.exit are
 * captured (not executed) so the mocha process itself survives.
 */
describe('index.ts SIGTERM/SIGINT registration -- emergency summary-file scrub then re-raise (#775)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules for the duration of each test
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = process as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callback = require('../src/callback') as any;
    const origGetInput = tasks.getInput;
    const origGetBoolInput = tasks.getBoolInput;
    const origGetVariable = tasks.getVariable;
    const origKill = process.kill.bind(process);
    const origExit = process.exit.bind(process);
    const origPost = callback.postJsonWithRetry;
    const indexModulePath = require.resolve('../src/index');
    const trackedEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;

    let scratchDir: string;
    let planFile: string;
    let killCalls: Array<{ pid: number; signal: string }>;
    let exitCalls: number[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listenerSnapshots: Map<string, any[]>;

    function summaryFiles(): string[] {
        return (fs.existsSync(scratchDir) ? fs.readdirSync(scratchDir) : []).filter((f) => f.startsWith('tsm-drift-report-'));
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-signal-e2e-'));
        planFile = path.join(scratchDir, 'plan.json');
        fs.writeFileSync(planFile, '{}');
        killCalls = [];
        exitCalls = [];

        listenerSnapshots = new Map();
        for (const event of trackedEvents) {
            listenerSnapshots.set(event, [...p.listeners(event)]);
        }

        t.getInput = (name: string) => {
            if (name === 'planJsonFile') return planFile;
            if (name === 'callbackUrl') return 'https://tsm.example.com/callback';
            if (name === 'callbackToken') return 'test-token';
            return undefined;
        };
        t.getBoolInput = () => false;
        t.getVariable = (name: string) => (name === 'Agent.TempDirectory' ? scratchDir : undefined);

        p.kill = (pid: number, signal?: string | number) => {
            killCalls.push({ pid, signal: String(signal ?? 'SIGTERM') });
            return true;
        };
        p.exit = (code?: number) => { exitCalls.push(code ?? 0); };

        // The real summarize() handles an empty plan gracefully (all zeros), so no
        // stub is needed; the callback POST then hangs, standing in for a TSM
        // callback still in flight when a termination signal arrives. (summarize is
        // a read-only ESM getter on the terraform-drift-contract package and cannot
        // be reassigned anyway -- postJsonWithRetry is same-task src and is writable.)
        callback.postJsonWithRetry = () => new Promise(() => { /* never resolves */ });

        delete require.cache[indexModulePath];
    });

    afterEach(() => {
        t.getInput = origGetInput;
        t.getBoolInput = origGetBoolInput;
        t.getVariable = origGetVariable;
        p.kill = origKill;
        p.exit = origExit;
        callback.postJsonWithRetry = origPost;
        delete require.cache[indexModulePath];

        for (const event of trackedEvents) {
            p.removeAllListeners(event);
            for (const listener of listenerSnapshots.get(event)!) {
                p.on(event, listener);
            }
        }
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    async function loadIndexAndConfirmSummaryWritten(): Promise<void> {
        require('../src/index');
        // run() is synchronous through writeSecretFile() and only suspends at the
        // first await (the callback POST), so the summary file is on disk by the
        // time require() returns; a microtask yield advances run() into the hanging
        // postJsonWithRetry (the realistic "signal arrives mid-run" state).
        await Promise.resolve();
        assert.strictEqual(summaryFiles().length, 1, `the writeSecretFile'd summary must exist once run() has started; found: ${summaryFiles().join(', ')}`);
    }

    function invokeFreshListener(event: typeof trackedEvents[number], ...args: unknown[]): void {
        const before = listenerSnapshots.get(event)!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listener signatures vary by event
        const fresh = p.listeners(event).find((listener: any) => !before.includes(listener));
        assert.ok(fresh, `index.ts must register a new ${event} listener on load`);
        fresh(...args);
    }

    it('SIGTERM: emergency cleanup scrubs+deletes the summary file, then the signal is re-raised', async () => {
        await loadIndexAndConfirmSummaryWritten();

        const listenersBefore = process.listenerCount('SIGTERM');
        process.emit('SIGTERM', 'SIGTERM');

        assert.strictEqual(summaryFiles().length, 0, 'emergencyCleanup() must delete the summary file when SIGTERM arrives mid-run');
        assert.strictEqual(process.listenerCount('SIGTERM'), listenersBefore - 1, 'the handler must remove itself before re-raising');
        assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
        assert.strictEqual(killCalls[0].pid, process.pid);
        assert.strictEqual(killCalls[0].signal, 'SIGTERM');
    });

    it('SIGINT: emergency cleanup scrubs+deletes the summary file, then the signal is re-raised', async () => {
        await loadIndexAndConfirmSummaryWritten();

        const listenersBefore = process.listenerCount('SIGINT');
        process.emit('SIGINT', 'SIGINT');

        assert.strictEqual(summaryFiles().length, 0, 'emergencyCleanup() must delete the summary file when SIGINT arrives mid-run');
        assert.strictEqual(process.listenerCount('SIGINT'), listenersBefore - 1, 'the handler must remove itself before re-raising');
        assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
        assert.strictEqual(killCalls[0].signal, 'SIGINT');
    });

    it('uncaughtException: emergency cleanup scrubs+deletes the summary file, then the process exits 1', async () => {
        await loadIndexAndConfirmSummaryWritten();

        invokeFreshListener('uncaughtException', new Error('boom'));

        assert.strictEqual(summaryFiles().length, 0, 'emergencyCleanup() must delete the summary file on an uncaught exception mid-run');
        assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
        assert.strictEqual(exitCalls[0], 1);
    });

    it('unhandledRejection: emergency cleanup scrubs+deletes the summary file, then the process exits 1', async () => {
        await loadIndexAndConfirmSummaryWritten();

        invokeFreshListener('unhandledRejection', new Error('boom'));

        assert.strictEqual(summaryFiles().length, 0, 'emergencyCleanup() must delete the summary file on an unhandled rejection mid-run');
        assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
        assert.strictEqual(exitCalls[0], 1);
    });
});
