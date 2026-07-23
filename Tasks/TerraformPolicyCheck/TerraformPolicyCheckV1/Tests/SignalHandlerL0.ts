import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');

/**
 * End-to-end coverage for src/index.ts's SIGTERM/SIGINT/uncaughtException/
 * unhandledRejection registration (#775): a pipeline cancellation mid-run must
 * run cleanup(tempDirs) -- deleting the cloned (possibly private) policy repo
 * and any generated Sentinel config dir -- and then re-raise the signal so the
 * process still dies promptly.
 *
 * Follows TerraformTaskV5's SignalHandlerL0.ts approach: rather than a
 * cross-process spawn + child.kill (non-deterministic on Windows, which
 * hard-terminates the target without ever invoking its listener), drive the
 * REAL, unmodified index.ts in-process (reloaded fresh via the require cache each
 * test). Two module seams are stubbed: resolvePolicyDir (to create+track a REAL
 * temp dir synchronously, standing in for a completed clone) and runOpa (to never
 * resolve, standing in for a policy engine still running when the signal arrives).
 * process.kill / process.exit are captured (not executed) so the mocha process
 * itself survives.
 */
describe('index.ts SIGTERM/SIGINT registration -- emergency cleanup then re-raise (#775)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules for the duration of each test
    const t = tasks as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = process as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policySource = require('../src/policy-source') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opaEngine = require('../src/opa-engine') as any;
    const origGetInput = tasks.getInput;
    const origWhich = tasks.which;
    const origKill = process.kill.bind(process);
    const origExit = process.exit.bind(process);
    const origResolve = policySource.resolvePolicyDir;
    const origRunOpa = opaEngine.runOpa;
    const indexModulePath = require.resolve('../src/index');
    const trackedEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;

    let scratchDir: string;
    let inputFile: string;
    let clonedDir: string;
    let killCalls: Array<{ pid: number; signal: string }>;
    let exitCalls: number[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listenerSnapshots: Map<string, any[]>;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-signal-e2e-'));
        inputFile = path.join(scratchDir, 'plan.json');
        fs.writeFileSync(inputFile, '{}');
        clonedDir = '';
        killCalls = [];
        exitCalls = [];

        listenerSnapshots = new Map();
        for (const event of trackedEvents) {
            listenerSnapshots.set(event, [...p.listeners(event)]);
        }

        t.getInput = (name: string) => {
            if (name === 'engine') return 'opa';
            if (name === 'inputFile') return inputFile;
            return undefined;
        };
        t.which = () => '/usr/bin/opa';

        p.kill = (pid: number, signal?: string | number) => {
            killCalls.push({ pid, signal: String(signal ?? 'SIGTERM') });
            return true;
        };
        p.exit = (code?: number) => { exitCalls.push(code ?? 0); };

        // Create+track a REAL temp dir synchronously (so it exists once require()
        // returns), then resolve. runOpa hangs -- standing in for a policy engine
        // still running when the termination signal arrives.
        policySource.resolvePolicyDir = async (tempDirs: string[]) => {
            clonedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-policy-repo-'));
            tempDirs.push(clonedDir);
            return clonedDir;
        };
        opaEngine.runOpa = () => new Promise(() => { /* never resolves */ });

        delete require.cache[indexModulePath];
    });

    afterEach(() => {
        t.getInput = origGetInput;
        t.which = origWhich;
        p.kill = origKill;
        p.exit = origExit;
        policySource.resolvePolicyDir = origResolve;
        opaEngine.runOpa = origRunOpa;
        delete require.cache[indexModulePath];

        for (const event of trackedEvents) {
            p.removeAllListeners(event);
            for (const listener of listenerSnapshots.get(event)!) {
                p.on(event, listener);
            }
        }
        fs.rmSync(scratchDir, { recursive: true, force: true });
        if (clonedDir) fs.rmSync(clonedDir, { recursive: true, force: true });
    });

    async function loadIndexAndConfirmCloneTracked(): Promise<void> {
        require('../src/index');
        // run() is synchronous up to `await resolvePolicyDir(tempDirs)`; the stub
        // creates the dir synchronously before returning its promise, so the dir
        // exists by the time require() returns. A microtask yield lets the awaited
        // resolvePolicyDir settle and run() advance into the hanging runOpa (the
        // realistic "signal arrives mid-run" state); the handlers are live either way.
        await Promise.resolve();
        assert.notStrictEqual(clonedDir, '', 'resolvePolicyDir stub must have created the tracked policy-repo dir');
        assert.strictEqual(fs.existsSync(clonedDir), true, 'the tracked policy-repo dir must exist once resolvePolicyDir has run');
    }

    function invokeFreshListener(event: typeof trackedEvents[number], ...args: unknown[]): void {
        const before = listenerSnapshots.get(event)!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listener signatures vary by event
        const fresh = p.listeners(event).find((listener: any) => !before.includes(listener));
        assert.ok(fresh, `index.ts must register a new ${event} listener on load`);
        fresh(...args);
    }

    it('SIGTERM: cleanup deletes the tracked policy-repo dir, then the signal is re-raised', async () => {
        await loadIndexAndConfirmCloneTracked();

        const listenersBefore = process.listenerCount('SIGTERM');
        process.emit('SIGTERM', 'SIGTERM');

        assert.strictEqual(fs.existsSync(clonedDir), false, 'cleanup() must delete the tracked policy-repo dir when SIGTERM arrives mid-run');
        assert.strictEqual(process.listenerCount('SIGTERM'), listenersBefore - 1, 'the handler must remove itself before re-raising');
        assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
        assert.strictEqual(killCalls[0].pid, process.pid);
        assert.strictEqual(killCalls[0].signal, 'SIGTERM');
    });

    it('SIGINT: cleanup deletes the tracked policy-repo dir, then the signal is re-raised', async () => {
        await loadIndexAndConfirmCloneTracked();

        const listenersBefore = process.listenerCount('SIGINT');
        process.emit('SIGINT', 'SIGINT');

        assert.strictEqual(fs.existsSync(clonedDir), false, 'cleanup() must delete the tracked policy-repo dir when SIGINT arrives mid-run');
        assert.strictEqual(process.listenerCount('SIGINT'), listenersBefore - 1, 'the handler must remove itself before re-raising');
        assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
        assert.strictEqual(killCalls[0].signal, 'SIGINT');
    });

    it('uncaughtException: cleanup deletes the tracked policy-repo dir, then the process exits 1', async () => {
        await loadIndexAndConfirmCloneTracked();

        invokeFreshListener('uncaughtException', new Error('boom'));

        assert.strictEqual(fs.existsSync(clonedDir), false, 'cleanup() must delete the tracked policy-repo dir on an uncaught exception mid-run');
        assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
        assert.strictEqual(exitCalls[0], 1);
    });

    it('unhandledRejection: cleanup deletes the tracked policy-repo dir, then the process exits 1', async () => {
        await loadIndexAndConfirmCloneTracked();

        invokeFreshListener('unhandledRejection', new Error('boom'));

        assert.strictEqual(fs.existsSync(clonedDir), false, 'cleanup() must delete the tracked policy-repo dir on an unhandled rejection mid-run');
        assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
        assert.strictEqual(exitCalls[0], 1);
    });
});
