import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');

/**
 * End-to-end coverage for src/index.ts's SIGTERM/SIGINT/uncaughtException/
 * unhandledRejection registration (#1113). The .terraformrc this task writes
 * is its intentional, persistent OUTPUT for a later `terraform init` to
 * consume, not a per-run secret to scrub on abnormal termination, so
 * cleanup() is a deliberate no-op -- but the handler is still registered so a
 * cancelled run dies promptly (re-raising the signal with its default
 * disposition) instead of lingering, and an unawaited rejection anywhere in a
 * helper no longer falls through to Node's default handling with no
 * tasks.setResult call and no deterministic exit code.
 *
 * Drives the REAL, unmodified index.ts in-process (reloaded fresh via the
 * require cache each test). tasks.getInput is stubbed to throw on its very
 * first call -- every task's run() reads an input as its first statement
 * (directly, or via a helper called before any other await), so this forces
 * run() to fail SYNCHRONOUSLY, before any real network/tool call a later
 * input read might otherwise reach. Without this, a task whose first input
 * read is optional (so it does not throw) can proceed into real async I/O
 * that keeps running in the background after this test's stubs are restored
 * in afterEach -- a later rejection then hits either a real network call with
 * no handler listening (an actual unhandled rejection in the shared mocha
 * process) or, worse, the still-registered index.ts handler with
 * process.exit/process.on already reverted to the originals, corrupting
 * whichever unrelated test happens to be running at that later tick. Forcing
 * an immediate synchronous throw is what makes this test file safe to run
 * against every task's index.ts with no task-specific stubbing.
 *
 * tasks.setResourcePath is also stubbed to a no-op. Real task-lib has no way
 * to UNSET a resource path once set, so calling the real one here (run()'s
 * actual first statement, before the input-read stub above ever fires) would
 * permanently switch tasks.loc() from its unresolved-key fallback to real
 * resolved strings for the REST of this mocha process -- corrupting any
 * later-registered test in this same file that calls tasks.loc() directly
 * expecting that fallback (this repo's own private-publisher url-builder
 * tests do exactly that). This test needs no real resource resolution of its
 * own, so the no-op is free.
 *
 * process.on and process.removeListener are spied (not replaced -- calls
 * still forward to the real implementation), and the registered handler is
 * CAPTURED from the spy and invoked directly (rather than via process.emit,
 * so the mocha runner's own signal handling is never disturbed). Capturing
 * from the spy rather than diffing process.listeners() at assertion time
 * matters here: run()'s forced synchronous throw reaches its own
 * catch/finally (which already removes the SIGTERM/SIGINT listeners as part
 * of normal completion) before this test ever gets to assert -- a
 * listeners() diff at that point would see nothing new and wrongly read as
 * "never registered." The captured handler reference is still valid and
 * invokable regardless of whether run()'s own finally already removed it
 * from process's real listener list. process.kill / process.exit are
 * captured (not executed) so the mocha process survives.
 */
describe('index.ts SIGTERM/SIGINT registration -- re-raise after (no-op) cleanup (#1113)', function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch process for the duration of each test
  const p = process as any;
  const origOn = process.on.bind(process);
  const origRemoveListener = process.removeListener.bind(process);
  const origKill = process.kill.bind(process);
  const origExit = process.exit.bind(process);
  const origGetInput = tasks.getInput;
  const origSetResourcePath = tasks.setResourcePath;
  const indexModulePath = require.resolve('../src/index');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onCalls: Array<{ event: string; handler: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let removeListenerCalls: Array<{ event: string; handler: any }>;
  let killCalls: Array<{ pid: number; signal: string }>;
  let exitCalls: number[];

  beforeEach(() => {
    onCalls = [];
    removeListenerCalls = [];
    killCalls = [];
    exitCalls = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.on = (event: string, handler: any) => {
      onCalls.push({ event, handler });
      return origOn(event, handler);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.removeListener = (event: string, handler: any) => {
      removeListenerCalls.push({ event, handler });
      return origRemoveListener(event, handler);
    };
    p.kill = (pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: String(signal ?? 'SIGTERM') });
      return true;
    };
    p.exit = (code?: number) => { exitCalls.push(code ?? 0); };

    // Force run()'s first input read to throw synchronously -- see the file
    // header for why this matters.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tasks as any).getInput = () => {
      throw new Error('SignalHandlerL0 stub: no inputs configured');
    };
    // No-op: see the file header for why the real one must never run here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tasks as any).setResourcePath = () => { /* stubbed for this test file */ };

    delete require.cache[indexModulePath];
  });

  afterEach(() => {
    // Any real listener run()'s own finally did NOT already remove (i.e. the
    // uncaughtException/unhandledRejection pair, which stays armed for the
    // process lifetime by design) must be cleaned up here so it does not leak
    // into later tests/files sharing this mocha process.
    for (const { event, handler } of onCalls) {
      origRemoveListener(event, handler);
    }
    p.on = origOn;
    p.removeListener = origRemoveListener;
    p.kill = origKill;
    p.exit = origExit;
    tasks.getInput = origGetInput;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tasks as any).setResourcePath = origSetResourcePath;
    delete require.cache[indexModulePath];
  });

  function loadIndex(): void {
    require('../src/index');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getHandler(event: string): any {
    const calls = onCalls.filter((c) => c.event === event);
    assert.ok(calls.length > 0, `index.ts must register a ${event} listener on load`);
    return calls[calls.length - 1].handler;
  }

  it('SIGTERM: the handler removes itself and re-raises the signal', () => {
    loadIndex();
    const handler = getHandler('SIGTERM');

    handler('SIGTERM');

    assert.ok(
      removeListenerCalls.some((c) => c.event === 'SIGTERM' && c.handler === handler),
      'the handler must remove itself before re-raising',
    );
    assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
    assert.strictEqual(killCalls[0].pid, process.pid);
    assert.strictEqual(killCalls[0].signal, 'SIGTERM');
  });

  it('SIGINT: the handler removes itself and re-raises the signal', () => {
    loadIndex();
    const handler = getHandler('SIGINT');

    handler('SIGINT');

    assert.ok(
      removeListenerCalls.some((c) => c.event === 'SIGINT' && c.handler === handler),
      'the handler must remove itself before re-raising',
    );
    assert.strictEqual(killCalls.length, 1, 'the signal must be re-raised via process.kill after cleanup');
    assert.strictEqual(killCalls[0].signal, 'SIGINT');
  });

  it('uncaughtException: the process exits 1 after cleanup', () => {
    loadIndex();
    const handler = getHandler('uncaughtException');

    handler(new Error('boom'));

    assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
    assert.strictEqual(exitCalls[0], 1);
  });

  it('unhandledRejection: the process exits 1 after cleanup', () => {
    loadIndex();
    const handler = getHandler('unhandledRejection');

    handler(new Error('boom'));

    assert.strictEqual(exitCalls.length, 1, 'the process must exit after cleanup');
    assert.strictEqual(exitCalls[0], 1);
  });
});
