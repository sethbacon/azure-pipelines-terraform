import * as assert from 'assert';
import { EventEmitter } from 'events';
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';

/**
 * Direct unit tests for execWithTimeout's wall-clock deadline (#822, CWE-1088).
 *
 * The `commandTimeoutMinutes` input only accepts whole minutes, multiplied
 * into a REAL `setTimeout` -- there is no fake-timer library in this repo, so
 * a test that actually waits for a minutes-driven deadline to fire would need
 * a genuine 60+ real seconds, exceeding mocha's default 10-second timeout.
 * getCommandTimeoutMinutes()'s parsing is tested directly instead (fast, no
 * timer involved), and the timer-firing/kill/reject MECHANISM is tested
 * exclusively via the explicit `timeoutMs` parameter (tiny values like
 * 20ms) -- this exercises the exact same shared Promise.race/
 * killChildProcess/reject code path the minutes-driven branch also uses,
 * just sourcing the numeric deadline differently.
 */

/** Minimal concrete handler exposing the protected methods under test. */
class TestHandler extends BaseTerraformCommandHandler {
    async handleBackend(): Promise<void> { /* no-op */ }
    async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> { /* no-op */ }
    async configureBackendCredentials(): Promise<void> { /* no-op */ }
    public execTimeout(
        tool: ToolRunner,
        options: IExecOptions,
        explicitTimeoutMs?: number,
        explicitTimeoutMessage?: string,
    ): Promise<number> {
        return this.execWithTimeout(tool, options, explicitTimeoutMs, explicitTimeoutMessage);
    }
    public commandTimeoutMinutes(): number | undefined {
        return this.getCommandTimeoutMinutes();
    }
}

/** Fake ToolRunner whose execAsync either resolves after a short real delay or never settles (a hang). */
class FakeTool extends EventEmitter {
    public killed = false;
    public killSignal: string | number | undefined;
    constructor(
        // undefined models a genuine hang: execAsync never resolves/rejects on
        // its own, so only the deadline's kill+reject can end the race.
        private readonly exitCode?: number,
        private readonly resolveAfterMs = 0,
    ) { super(); }
    killChildProcess(signal?: string | number): void {
        this.killed = true;
        this.killSignal = signal;
    }
    execAsync(_options: IExecOptions): Promise<number> {
        if (this.exitCode === undefined) {
            return new Promise<number>(() => { /* never settles -- models a hang */ });
        }
        const code = this.exitCode;
        return new Promise<number>(resolve => setTimeout(() => resolve(code), this.resolveAfterMs));
    }
}

function asTool(fake: FakeTool): ToolRunner {
    return fake as unknown as ToolRunner;
}

describe('execWithTimeout — always-passthrough when no deadline applies', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const originalGetInput = t.getInput;

    function stubCommandTimeoutMinutes(value: string | undefined): void {
        t.getInput = (name: string, required?: boolean): string | undefined =>
            name === 'commandTimeoutMinutes' ? value : originalGetInput(name, required);
    }

    afterEach(() => {
        t.getInput = originalGetInput;
    });

    it('passes straight through with no timer when commandTimeoutMinutes is unset', async () => {
        stubCommandTimeoutMinutes(undefined);
        const fake = new FakeTool(0);
        const result = await new TestHandler().execTimeout(asTool(fake), {} as IExecOptions);
        assert.strictEqual(result, 0);
        assert.strictEqual(fake.killed, false);
    });

    it('passes straight through with no timer when commandTimeoutMinutes is "0"', async () => {
        stubCommandTimeoutMinutes('0');
        const fake = new FakeTool(0);
        const result = await new TestHandler().execTimeout(asTool(fake), {} as IExecOptions);
        assert.strictEqual(result, 0);
        assert.strictEqual(fake.killed, false);
    });
});

describe('execWithTimeout — minutes-based deadline success path', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const originalGetInput = t.getInput;

    afterEach(() => {
        t.getInput = originalGetInput;
    });

    it('wins the Promise.race and returns the exit code when the command finishes well before the deadline', async () => {
        // A real (but far-off) 5-minute deadline -- never expected to fire,
        // since the fake command resolves in a few milliseconds. Proves the
        // minutes branch's Promise.race/clearTimeout wiring without waiting
        // anywhere near the real 5 minutes.
        t.getInput = (name: string, required?: boolean): string | undefined =>
            name === 'commandTimeoutMinutes' ? '5' : originalGetInput(name, required);
        const fake = new FakeTool(0, 5);
        const result = await new TestHandler().execTimeout(asTool(fake), {} as IExecOptions);
        assert.strictEqual(result, 0);
        assert.strictEqual(fake.killed, false, 'the far-off deadline must never fire');
    });
});

describe('execWithTimeout — explicit timeoutMs mechanism (shared by az login/account set, #822)', function () {
    it('kills the child and rejects with the supplied message when a hung command exceeds an explicit timeoutMs', async () => {
        const fake = new FakeTool(); // never resolves -- models a genuine hang
        await assert.rejects(
            () => new TestHandler().execTimeout(asTool(fake), {} as IExecOptions, 20, 'aux call timed out'),
            /aux call timed out/,
        );
        assert.strictEqual(fake.killed, true, 'the hung child must be killed');
        assert.strictEqual(fake.killSignal, 'SIGKILL');
    });

    it('does not conflate a non-zero exit code with a timeout when using an explicit timeoutMs', async () => {
        const fake = new FakeTool(3, 5); // resolves quickly with a failure code, well under the deadline
        const result = await new TestHandler().execTimeout(asTool(fake), {} as IExecOptions, 5000, 'should never fire');
        assert.strictEqual(result, 3);
        assert.strictEqual(fake.killed, false, 'a fast non-zero exit must not be treated as a timeout');
    });
});

describe('getCommandTimeoutMinutes — input parsing', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const originalGetInput = t.getInput;

    afterEach(() => {
        t.getInput = originalGetInput;
    });

    const cases: Array<{ raw: string | undefined; expected: number | undefined }> = [
        { raw: undefined, expected: undefined },
        { raw: '', expected: undefined },
        { raw: '0', expected: undefined },
        { raw: '-5', expected: undefined },
        { raw: 'not-a-number', expected: undefined },
        { raw: '5', expected: 5 },
        { raw: '5.7', expected: 5 },
    ];

    for (const { raw, expected } of cases) {
        it(`parses commandTimeoutMinutes=${JSON.stringify(raw)} as ${expected}`, () => {
            t.getInput = (name: string, required?: boolean): string | undefined =>
                name === 'commandTimeoutMinutes' ? raw : originalGetInput(name, required);
            assert.strictEqual(new TestHandler().commandTimeoutMinutes(), expected);
        });
    }
});
