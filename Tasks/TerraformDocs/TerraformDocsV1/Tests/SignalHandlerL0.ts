import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');

/**
 * End-to-end coverage for src/index.ts's SIGTERM/SIGINT/uncaughtException/
 * unhandledRejection registration (#775). Unlike TerraformDriftReportV1/
 * TerraformPolicyCheckV1 (whose handlers scrub a sensitive temp dir), this task
 * writes no sensitive temp file, so cleanup() is a deliberate no-op -- but the
 * handler is still registered so a cancelled run dies promptly (re-raising the
 * signal with its default disposition) instead of lingering, and so a future
 * addition of temp-file handling inherits the same cancellation discipline.
 *
 * Follows TerraformPolicyCheckV1's SignalHandlerL0.ts approach: drive the REAL,
 * unmodified index.ts in-process (reloaded fresh via the require cache each test)
 * with the long-running seam stubbed. execWithTimeout is stubbed to never resolve
 * (standing in for terraform-docs still running when the signal arrives), and the
 * registered listener is invoked directly (rather than process.emit) so the mocha
 * runner's own signal handling is never disturbed. process.kill / process.exit are
 * captured (not executed) so the mocha process survives.
 */
describe('index.ts SIGTERM/SIGINT registration -- re-raise after (no-op) cleanup (#775)', function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch shared modules for the duration of each test
  const t = tasks as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = process as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execTimeout = require('../src/exec-timeout') as any;
  const origGetInput = tasks.getInput;
  const origGetPathInput = tasks.getPathInput;
  const origGetBoolInput = tasks.getBoolInput;
  const origWhich = tasks.which;
  const origTool = tasks.tool;
  const origKill = process.kill.bind(process);
  const origExit = process.exit.bind(process);
  const origExecWithTimeout = execTimeout.execWithTimeout;
  const indexModulePath = require.resolve('../src/index');
  const trackedEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;

  let killCalls: Array<{ pid: number; signal: string }>;
  let exitCalls: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenerSnapshots: Map<string, any[]>;

  beforeEach(() => {
    killCalls = [];
    exitCalls = [];

    listenerSnapshots = new Map();
    for (const event of trackedEvents) {
      listenerSnapshots.set(event, [...p.listeners(event)]);
    }

    t.getInput = (name: string) => {
      if (name === 'formatter') return 'markdown-table';
      return undefined;
    };
    t.getPathInput = (name: string) => {
      if (name === 'modulePath') return '.';
      return undefined;
    };
    t.getBoolInput = () => false;
    t.which = () => '/usr/bin/terraform-docs';
    // Minimal ToolRunner stand-in: index.ts only chains .arg()/.line()/.on()
    // before awaiting execWithTimeout (which we hang below).
    t.tool = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fake: any = {
        arg: () => fake,
        line: () => fake,
        on: () => fake,
      };
      return fake;
    };

    p.kill = (pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: String(signal ?? 'SIGTERM') });
      return true;
    };
    p.exit = (code?: number) => { exitCalls.push(code ?? 0); };

    // terraform-docs "still running" when the termination signal arrives.
    execTimeout.execWithTimeout = () => new Promise(() => { /* never resolves */ });

    delete require.cache[indexModulePath];
  });

  afterEach(() => {
    t.getInput = origGetInput;
    t.getPathInput = origGetPathInput;
    t.getBoolInput = origGetBoolInput;
    t.which = origWhich;
    t.tool = origTool;
    p.kill = origKill;
    p.exit = origExit;
    execTimeout.execWithTimeout = origExecWithTimeout;
    delete require.cache[indexModulePath];

    for (const event of trackedEvents) {
      p.removeAllListeners(event);
      for (const listener of listenerSnapshots.get(event)!) {
        p.on(event, listener);
      }
    }
  });

  async function loadIndex(): Promise<void> {
    require('../src/index');
    // run() registers the handlers synchronously before its first await, then
    // parks at the hanging execWithTimeout. A microtask yield lets it advance
    // into that awaited state (the realistic "signal arrives mid-run" state);
    // the handlers are live either way.
    await Promise.resolve();
  }

  function invokeFreshListener(event: typeof trackedEvents[number], ...args: unknown[]): void {
    const before = listenerSnapshots.get(event)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listener signatures vary by event
    const fresh = p.listeners(event).find((listener: any) => !before.includes(listener));
    assert.ok(fresh, `index.ts must register a new ${event} listener on load`);
    fresh(...args);
  }

  it('SIGTERM: the handler removes itself and re-raises the signal', async () => {
    await loadIndex();

    const listenersBefore = process.listenerCount('SIGTERM');
    invokeFreshListener('SIGTERM', 'SIGTERM');

    assert.strictEqual(process.listenerCount('SIGTERM'), listenersBefore - 1, 'the handler must remove itself before re-raising');
    assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
    assert.strictEqual(killCalls[0].pid, process.pid);
    assert.strictEqual(killCalls[0].signal, 'SIGTERM');
  });

  it('SIGINT: the handler removes itself and re-raises the signal', async () => {
    await loadIndex();

    const listenersBefore = process.listenerCount('SIGINT');
    invokeFreshListener('SIGINT', 'SIGINT');

    assert.strictEqual(process.listenerCount('SIGINT'), listenersBefore - 1, 'the handler must remove itself before re-raising');
    assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
    assert.strictEqual(killCalls[0].signal, 'SIGINT');
  });

  it('uncaughtException: the process exits 1 after cleanup', async () => {
    await loadIndex();

    invokeFreshListener('uncaughtException', new Error('boom'));

    assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
    assert.strictEqual(exitCalls[0], 1);
  });

  it('unhandledRejection: the process exits 1 after cleanup', async () => {
    await loadIndex();

    invokeFreshListener('unhandledRejection', new Error('boom'));

    assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
    assert.strictEqual(exitCalls[0], 1);
  });
});
