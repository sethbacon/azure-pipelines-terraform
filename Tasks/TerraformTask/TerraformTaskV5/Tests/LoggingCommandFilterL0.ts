import * as assert from 'assert';
import * as path from 'path';
import { Writable } from 'stream';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';

/**
 * CLASS TEST -- logging commands in terraform's own output.
 *
 * terraform's output carries text the pipeline does not control: provider
 * messages, provisioner output, and values from configuration or remote state.
 * The agent treats a `##vso[...]` line on a task's stdout as a logging command,
 * so before this filter a crafted value could set a pipeline variable, raise
 * warnings or mark the task Failed simply by being printed. The paths that
 * re-print captured output (plan/apply/show echoes) already neutralized it via
 * echoSafeConsoleLine (#678, #869); every other command streamed terraform's
 * output to the log untouched.
 *
 * Every TerraformTaskV5 invocation goes through CommandExecutor.execWithTimeout,
 * which now passes azure-pipelines-task-lib's `externalOutput` option, so the
 * agent sees `##_vso[...]` instead. `allowTerraformLoggingCommands` is the
 * opt-out for pipelines that print logging commands on purpose; it restores the
 * old unfiltered stream and warns.
 */

class TestHandler extends BaseTerraformCommandHandler {
    async handleBackend(): Promise<void> { /* no-op */ }
    async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> { /* no-op */ }
    async configureBackendCredentials(): Promise<void> { /* no-op */ }
    public exec(tool: ToolRunner, options: IExecOptions): Promise<number> {
        return this.commandExecutor.execWithTimeout(tool, options);
    }
    public capture(tool: ToolRunner, options: IExecOptions) {
        return this.commandExecutor.execWithStdoutCapture(tool, options);
    }
}

/** A child process that prints logging commands, the way terraform could relay them. */
function childPrinting(lines: string[]): ToolRunner {
    return tasks.tool(process.execPath).arg(['-e', `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')})`]);
}

function collector(): { stream: Writable; text: () => string } {
    const chunks: Buffer[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

const INJECTED = [
    'plain output line',
    '##vso[task.setvariable variable=injected]pwned',
    '##vso[task.complete result=Failed;]injected failure',
];

describe('logging commands in terraform output are neutralized (class test)', function () {
    this.timeout(30000);

    // task-lib copies INPUT_* into its vault when first imported, so an env var
    // set here would never be read; stub the reader instead, as
    // ExecWithTimeoutL0 does for commandTimeoutMinutes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const originalGetBoolInput = t.getBoolInput;
    afterEach(() => { t.getBoolInput = originalGetBoolInput; });

    it('mock run: logging commands terraform prints never reach the agent', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'LoggingCommandTests', 'ValidateLoggingCommandsBlocked.js'));
        await tr.runAsync();
        assert(tr.succeeded, `an injected task.complete must not fail the run\n${tr.stdout}`);
        assert.strictEqual(tr.warningIssues.length, 0, `an injected task.issue must not raise a warning: ${tr.warningIssues}`);
        for (const marker of [/^##vso\[task\.setvariable variable=injected/m, /^##vso\[task\.issue type=warning;\]injected/m, /^##vso\[task\.complete result=Failed;\]injected/m]) {
            assert(!marker.test(tr.stdout), `${marker} reached the agent unfiltered\n${tr.stdout}`);
        }
        assert(tr.stdout.includes('##_vso[task.setvariable variable=injected]pwned'), 'the line stays visible in the log, neutralized');
    });

    it('mock run: allowTerraformLoggingCommands passes them through and warns', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'LoggingCommandTests', 'ValidateLoggingCommandsAllowed.js'));
        await tr.runAsync();
        assert(tr.succeeded, tr.stdout);
        assert(/^##vso\[task\.setvariable variable=deliberate\]value/m.test(tr.stdout), 'the opt-out must stream terraform output unfiltered');
        assert(tr.warningIssues.includes('deliberate warning'), `the deliberate logissue must reach the agent: ${tr.warningIssues}`);
        // No resource path under the mock runner, so loc() yields loc_mock_<key>.
        assert(tr.warningIssues.some(w => w.includes('TerraformLoggingCommandsAllowed')), `the task must warn that filtering is off: ${tr.warningIssues}`);
    });

    it('real ToolRunner: execWithTimeout streams a child\'s logging commands neutralized', async () => {
        const out = collector();
        const code = await new TestHandler().exec(childPrinting(INJECTED), { outStream: out.stream, errStream: out.stream });
        assert.strictEqual(code, 0);
        const text = out.text();
        assert(text.includes('plain output line'), text);
        assert(!/^##vso\[task\.(setvariable|complete)/m.test(text), `logging commands reached the stream unfiltered:\n${text}`);
        assert(text.includes('##_vso[task.setvariable variable=injected]pwned'), text);
    });

    it('real ToolRunner: the opt-out restores the unfiltered stream', async () => {
        t.getBoolInput = (name: string, required?: boolean): boolean =>
            name === 'allowTerraformLoggingCommands' ? true : originalGetBoolInput(name, required);
        const out = collector();
        await new TestHandler().exec(childPrinting(INJECTED), { outStream: out.stream, errStream: out.stream });
        assert(/^##vso\[task\.setvariable variable=injected\]pwned/m.test(out.text()), out.text());
    });

    it('real ToolRunner: captured output keeps the raw bytes, so output -json / show -json parse unchanged', async () => {
        const json = JSON.stringify({ note: { value: '##vso[task.setvariable variable=x]y' } });
        const result = await new TestHandler().capture(childPrinting([json]), {});
        assert.strictEqual(result.stdout.trim(), json, 'the filter must not touch what a capture hands to the JSON parsers');
    });
});
