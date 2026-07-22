import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import { ParentCommandHandler } from '../src/parent-handler';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { writeSecretFile } from '../src/secure-temp';

/**
 * End-to-end coverage for src/index.ts's SIGTERM/SIGINT registration (#758).
 * index.js was previously excluded from coverage entirely (.nycrc.json) and
 * had no test exercising the actual `process.on('SIGTERM'/'SIGINT', ...)`
 * wiring itself -- only the cleanup logic it calls (ParentCommandHandler.
 * emergencyCleanup / BaseTerraformCommandHandler.emergencyCleanupTempFiles)
 * was covered in isolation (EmergencyOnlyCleanupL0.ts, EmergencyCleanupNoHandlerL0.ts).
 *
 * A true separate-process spawn + child.kill(signal) was evaluated first, but
 * real cross-process signal delivery is not deterministic across the
 * platforms this repo is developed on: on Windows, `child.kill('SIGTERM')`
 * (confirmed empirically, and even a self-directed
 * `process.kill(process.pid, 'SIGTERM')`) unconditionally hard-terminates the
 * target via TerminateProcess without ever invoking its registered
 * `process.on('SIGTERM', ...)` listener, so a real-spawn version of this test
 * could only ever be meaningfully verified on the Linux runners CI actually
 * uses -- exactly the class of environment-dependent flakiness the sibling
 * symlink test above (search "#757") was rewritten away from in this same
 * batch, in favor of a deterministic, causally-equivalent proof.
 *
 * Instead, this drives the REAL, unmodified index.ts module (reloaded fresh
 * via the require cache each test) in-process: its actual `run()` registers
 * the actual SIGTERM/SIGINT/uncaughtException/unhandledRejection listeners
 * against the real `process` object, and its `handleTerminationSignal` calls
 * the real `ParentCommandHandler.emergencyCleanup()` -> real
 * `BaseTerraformCommandHandler.emergencyCleanupTempFiles()` chain against a
 * real tracked temp file written via the real `writeSecretFile()`. Only two
 * seams are stubbed, both unavoidable to run this safely in a test process:
 * `ParentCommandHandler.prototype.execute` (so no real terraform binary/cloud
 * call is needed, and so it stays pending -- simulating a signal arriving
 * mid-run, the realistic cancellation scenario) and `process.kill` (so the
 * final "re-raise with default disposition" step doesn't actually terminate
 * the mocha process itself; the call is captured and asserted on instead --
 * the same "assert the causal proof, not the full OS-level outcome" approach
 * the symlink test documents).
 */
describe('index.ts SIGTERM/SIGINT registration -- emergency cleanup then re-raise (#758)', function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules for the duration of each test
  const t = tasks as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = process as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pch = ParentCommandHandler.prototype as any;
  const origGetInput = tasks.getInput;
  const origKill = process.kill.bind(process);
  const origExit = process.exit.bind(process);
  const origExecute = ParentCommandHandler.prototype.execute;
  const indexModulePath = require.resolve('../src/index');
  const trackedEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;

  let scratchDir: string;
  let credentialFile: string;
  let killCalls: Array<{ pid: number; signal: string }>;
  let exitCalls: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenerSnapshots: Map<string, any[]>;

  /** Concrete handler exposing the protected temp-file array, mirroring EmergencyOnlyCleanupL0.ts's TestHandler. */
  class HangingTestHandler extends BaseTerraformCommandHandler {
    async handleBackend(): Promise<void> { /* no-op: not exercised by this test */ }
    async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> { /* no-op: not exercised by this test */ }
    async configureBackendCredentials(): Promise<void> { /* no-op: not exercised by this test */ }
    public trackTemp(target: string): void { this.tempFiles.push(target); }
  }

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-signal-e2e-'));
    credentialFile = path.join(scratchDir, 'fake-credential.json');
    killCalls = [];
    exitCalls = [];

    // Snapshot every listener on the events index.ts registers so this
    // test's own registrations can be fully undone afterward, regardless
    // of what mocha or earlier-run test files already had attached.
    listenerSnapshots = new Map();
    for (const event of trackedEvents) {
      listenerSnapshots.set(event, [...p.listeners(event)]);
    }

    t.getInput = () => 'test-value';

    p.kill = (pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: String(signal ?? 'SIGTERM') });
      return true;
    };

    p.exit = (code?: number) => {
      exitCalls.push(code ?? 0);
    };

    // Replace execute() with one that writes+tracks a real temp file (via
    // the real writeSecretFile()) on a real handler instance, then never
    // resolves -- standing in for a terraform command still running when
    // a termination signal arrives.
    pch.execute = function (): Promise<number> {
      writeSecretFile(credentialFile, 'fake-secret-for-test');
      const handler = new HangingTestHandler();
      handler.trackTemp(credentialFile);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reach past the private `handlers` field to seed it for this test
      (this as any).handlers.push(handler);
      return new Promise<number>(() => { /* never resolves: simulates a still-running terraform command */ });
    };

    delete require.cache[indexModulePath];
  });

  afterEach(() => {
    t.getInput = origGetInput;
    p.kill = origKill;
    p.exit = origExit;
    pch.execute = origExecute;
    delete require.cache[indexModulePath];

    for (const event of trackedEvents) {
      p.removeAllListeners(event);
      for (const listener of listenerSnapshots.get(event)!) {
        p.on(event, listener);
      }
    }

    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  /**
   * index.ts's run() is async but fully synchronous up to (and including)
   * the `parentHandler.execute(...)` call site -- registering every signal
   * listener and writing+tracking the credential file happens before the
   * first (and, with the stub above, only ever) await suspends it. No
   * tick/microtask wait is needed: by the time require() returns, the
   * listeners are live and the temp file is already on disk.
   */
  function loadIndexAndConfirmHandlerStarted(): void {
    require('../src/index');
    assert.strictEqual(fs.existsSync(credentialFile), true, 'the real writeSecretFile()-tracked credential file must exist once execute() has started');
  }

  /**
   * uncaughtException/unhandledRejection are ALSO listened for by Mocha's own
   * runner (its safety net for stray async errors) -- unlike SIGTERM/SIGINT,
   * which mocha does not hook. process.emit(...) for these two events would
   * fan out to mocha's own listener too, which defers its handling via
   * setImmediate and misattributes the resulting "Uncaught Error" to whatever
   * test mocha happens to be running by the time it fires -- proven to cascade
   * into unrelated later-test failures before this helper was introduced.
   * Instead, find the ONE listener index.ts's fresh require() just added
   * (diffed against the pre-load snapshot) and invoke it directly, exactly as
   * Node's own internal fatal-exception path would call it -- without ever
   * going through process.emit()/mocha's competing listener.
   */
  function invokeFreshListener(event: typeof trackedEvents[number], ...args: unknown[]): void {
    const before = listenerSnapshots.get(event)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listener signatures vary by event
    const fresh = p.listeners(event).find((listener: any) => !before.includes(listener));
    assert.ok(fresh, `index.ts must register a new ${event} listener on load`);
    fresh(...args);
  }

  it('SIGTERM: emergency cleanup deletes the tracked temp file, then the signal is re-raised', () => {
    loadIndexAndConfirmHandlerStarted();

    const listenersBefore = process.listenerCount('SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');

    assert.strictEqual(fs.existsSync(credentialFile), false, 'emergencyCleanup() must delete the tracked temp file when SIGTERM arrives mid-run');
    assert.strictEqual(process.listenerCount('SIGTERM'), listenersBefore - 1, 'the handler must remove itself before re-raising (index.ts)');
    assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
    assert.strictEqual(killCalls[0].pid, process.pid);
    assert.strictEqual(killCalls[0].signal, 'SIGTERM');
  });

  it('SIGINT: emergency cleanup deletes the tracked temp file, then the signal is re-raised', () => {
    loadIndexAndConfirmHandlerStarted();

    const listenersBefore = process.listenerCount('SIGINT');
    process.emit('SIGINT', 'SIGINT');

    assert.strictEqual(fs.existsSync(credentialFile), false, 'emergencyCleanup() must delete the tracked temp file when SIGINT arrives mid-run');
    assert.strictEqual(process.listenerCount('SIGINT'), listenersBefore - 1, 'the handler must remove itself before re-raising (index.ts)');
    assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
    assert.strictEqual(killCalls[0].pid, process.pid);
    assert.strictEqual(killCalls[0].signal, 'SIGINT');
  });

  it('uncaughtException: emergency cleanup deletes the tracked temp file, then the process exits with code 1 (#755 sibling)', () => {
    loadIndexAndConfirmHandlerStarted();

    invokeFreshListener('uncaughtException', new Error('boom'));

    assert.strictEqual(fs.existsSync(credentialFile), false, 'emergencyCleanup() must delete the tracked temp file when an uncaught exception occurs mid-run');
    assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup and reporting the failure');
    assert.strictEqual(exitCalls[0], 1);
  });

  it('unhandledRejection: emergency cleanup deletes the tracked temp file, then the process exits with code 1 (#755 sibling)', () => {
    loadIndexAndConfirmHandlerStarted();

    invokeFreshListener('unhandledRejection', new Error('boom'), Promise.resolve());

    assert.strictEqual(fs.existsSync(credentialFile), false, 'emergencyCleanup() must delete the tracked temp file when an unhandled rejection occurs mid-run');
    assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup and reporting the failure');
    assert.strictEqual(exitCalls[0], 1);
  });
});
