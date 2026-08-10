import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformAuthorizationCommandInitializer } from '../src/terraform-commands';
import { ITerraformToolHandler } from '../src/terraform';

/**
 * THE CLASS TEST for the captured-terraform-output echo/file-write protection
 * defect class (#869, #868): output the task has already captured (silently,
 * via execWithStdoutCapture) must never be re-emitted to the console or
 * written to a task-controlled file without the same protections its sibling
 * code paths apply -- the ##vso logging-command neutralizer on echo,
 * sensitive-value detection, and temp-file cleanup registration.
 *
 * Rows are the enumerated sibling-sweep call sites, not one test per issue:
 * show()'s console branch (#869, fixed here) and custom()'s file branch
 * (#868, fixed here -- both its sensitive-detected and non-JSON-default
 * paths, plus the strict fail-closed path). plan()/apply()/show()-file/
 * output() -- the already-safe siblings that proved the pattern -- keep their
 * own dedicated regression tests (AzurePlanMessageNeutralizesVsoInjection,
 * AzureApplyMessageNeutralizesVsoInjection, AzureShowFileJsonSensitive(+
 * Strict), AWSShowSensitiveAutoCleanup(+OptOut)) rather than being duplicated
 * here.
 *
 * Bypasses ToolRunner/mock-run entirely: neither show() nor custom() call
 * .arg()/.line() on the ToolRunner outside execWithStdoutCapture, so
 * overriding that one protected seam with canned captured output is enough --
 * mirrors this repo's own EmergencyOnlyCleanupL0.ts (direct tempFiles/
 * emergencyOnlyTempFiles access via a subclass) and
 * CredentialFailClosedMatrixL0.ts (monkeypatching the shared tasks module
 * directly, table-driven `for (const row of ROWS)` rows). Each row is
 * mutation-provable: reverting either fix in base-terraform-command-handler.ts
 * turns its row red.
 */

class TestHandler extends BaseTerraformCommandHandler {
    public nextCapture: { code: number; stdout: string; stderr: string } = { code: 0, stdout: '', stderr: '' };

    async handleBackend(): Promise<void> { /* no-op */ }
    async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> { /* no-op */ }
    async configureBackendCredentials(): Promise<void> { /* no-op */ }

    // Test seam: replaces the real ToolRunner/exec pipeline with canned output.
    protected async execWithStdoutCapture(_terraformTool: ToolRunner, _options: IExecOptions): Promise<{ code: number; stdout: string; stderr: string }> {
        return this.nextCapture;
    }

    public get trackedTempFiles(): readonly string[] { return this.tempFileManager.tracked; }
    public get trackedEmergencyOnlyTempFiles(): readonly string[] { return this.tempFileManager.trackedEmergencyOnly; }
}

/** A ToolRunner is only ever created then handed to execWithStdoutCapture (overridden above) by show()/custom() -- a no-op stub is enough to avoid the real tasks.which/tasks.tool lookup. */
function fakeToolHandler(): ITerraformToolHandler {
    const stub: Record<string, unknown> = {};
    stub.arg = () => stub;
    stub.line = () => stub;
    stub.on = () => stub;
    stub.killChildProcess = () => undefined;
    return { createToolRunner: () => stub as unknown as ToolRunner };
}

interface Row {
    name: string;
    command: 'show' | 'custom';
    inputs: Record<string, string>;
    bools?: Record<string, boolean>;
    capture: { code: number; stdout: string; stderr: string };
    /** When set, the command is expected to reject with a message matching this. */
    expectRejection?: RegExp;
    verify: (ctx: {
        handler: TestHandler;
        response?: number;
        consoleLogs: string[];
        warnings: string[];
        filePath: string;
    }) => void;
}

describe('captured terraform output: console-echo neutralization + file-write protection class (#869, #868)', function () {
    this.timeout(10000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const orig = {
        getInput: t.getInput, getBoolInput: t.getBoolInput, getVariable: t.getVariable,
        setVariable: t.setVariable, warning: t.warning, debug: t.debug,
        addAttachment: t.addAttachment, loc: t.loc,
    };

    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-capture-protection-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
        Object.assign(t, orig);
    });

    const ROWS: Row[] = [
        {
            name: 'show() console branch neutralizes an embedded ##vso[...] line before echoing to the console (#869)',
            command: 'show',
            inputs: { outputTo: 'console', outputFormat: '', commandOptions: '' },
            capture: {
                code: 0,
                stdout: ['normal line', '##vso[task.setvariable variable=pwned]evil', 'more text'].join('\n'),
                stderr: '',
            },
            verify: ({ response, consoleLogs }) => {
                assert.strictEqual(response, 0);
                const joined = consoleLogs.join('\n');
                assert.ok(!joined.includes('##vso[task.setvariable variable=pwned'),
                    `unneutralized ##vso[...] logging command reached the console: ${joined}`);
                assert.ok(joined.includes('#vso[task.setvariable variable=pwned') && joined.includes('evil'),
                    `expected the injected line's content to still be visible (neutralized, not swallowed): ${joined}`);
                assert.ok(joined.includes('normal line') && joined.includes('more text'),
                    `expected the show text's other lines to still be echoed: ${joined}`);
            },
        },
        {
            name: 'custom() file branch with -json auto-registers and scrubs a file containing sensitive output (#868)',
            command: 'custom',
            inputs: { customCommand: 'show', outputTo: 'file', filename: 'custom-output.json', commandOptions: '-json' },
            capture: {
                code: 0,
                stdout: JSON.stringify({ planned_values: { outputs: { db_password: { sensitive: true, value: 'hunter2' } } } }),
                stderr: '',
            },
            verify: ({ handler, response, warnings, filePath }) => {
                assert.strictEqual(response, 0);
                assert.ok(fs.existsSync(filePath), 'the custom output file should have been written');
                assert.ok(warnings.some((w) => w.includes('sensitive')), `expected a sensitive-output warning, got: ${warnings.join(' | ')}`);
                assert.ok(handler.trackedTempFiles.includes(filePath), 'a file containing sensitive output must be registered for normal-completion cleanup');
                assert.ok(!handler.trackedEmergencyOnlyTempFiles.includes(filePath));
                handler.cleanupTempFiles();
                assert.ok(!fs.existsSync(filePath), 'the sensitive custom output file must be scrubbed+deleted at normal step end');
            },
        },
        {
            name: 'custom() file branch with -json and failOnSensitiveOutputs=true fails closed and still cleans up the file (#868)',
            command: 'custom',
            inputs: { customCommand: 'show', outputTo: 'file', filename: 'custom-output.json', commandOptions: '-json' },
            bools: { failOnSensitiveOutputs: true },
            capture: {
                code: 0,
                stdout: JSON.stringify({ planned_values: { outputs: { db_password: { sensitive: true, value: 'hunter2' } } } }),
                stderr: '',
            },
            expectRejection: /ShowSensitiveOutputsStrictFailure/,
            verify: ({ handler, filePath }) => {
                assert.ok(handler.trackedTempFiles.includes(filePath), 'the file must be registered for cleanup even though the strict check threw');
                handler.cleanupTempFiles();
                assert.ok(!fs.existsSync(filePath), 'the file must be scrubbed+deleted despite the strict failure');
            },
        },
        {
            name: 'custom() file branch without -json skips the sensitivity check and only cleans up on cancellation (#868)',
            command: 'custom',
            inputs: { customCommand: 'graph', outputTo: 'file', filename: 'custom-output.json', commandOptions: '' },
            capture: { code: 0, stdout: 'digraph { }\n', stderr: '' },
            verify: ({ handler, response, warnings, filePath }) => {
                assert.strictEqual(response, 0);
                assert.strictEqual(warnings.length, 0, `expected no sensitivity-check noise for non-JSON custom output, got: ${warnings.join(' | ')}`);
                assert.ok(handler.trackedEmergencyOnlyTempFiles.includes(filePath), 'a non-JSON custom output file must still be registered for emergency-only cleanup');
                assert.ok(!handler.trackedTempFiles.includes(filePath));
                handler.cleanupTempFiles();
                assert.ok(fs.existsSync(filePath), 'the file must survive a normal step so a downstream step can still read it');
                handler.emergencyCleanupTempFiles();
                assert.ok(!fs.existsSync(filePath), 'the file must be scrubbed+deleted on cancellation');
            },
        },
    ];

    for (const row of ROWS) {
        it(row.name, async () => {
            const common: Record<string, string> = {
                provider: 'azurerm',
                environmentServiceNameAzureRM: 'AzureRM',
                workingDirectory: scratchDir,
            };
            t.getInput = (name: string, required?: boolean) => {
                const v = row.inputs[name] ?? common[name];
                if (required && !v) throw new Error(`Input required: ${name}`);
                return v;
            };
            t.getBoolInput = (name: string) => row.bools?.[name] ?? false;
            t.getVariable = () => undefined;
            t.setVariable = () => { /* no-op */ };
            const warnings: string[] = [];
            t.warning = (msg: string) => { warnings.push(msg); };
            t.debug = () => { /* silence */ };
            t.addAttachment = () => { /* no-op */ };
            t.loc = (key: string, ...args: unknown[]) => `${key}:${args.join(',')}`;

            const handler = new TestHandler();
            handler.terraformToolHandler = fakeToolHandler();
            handler.nextCapture = row.capture;

            const consoleLogs: string[] = [];
            const originalLog = console.log;
            console.log = (...args: unknown[]) => { consoleLogs.push(args.map(String).join(' ')); };

            const filePath = path.join(scratchDir, row.inputs.filename ?? '__no-file__');
            let response: number | undefined;
            try {
                if (row.expectRejection) {
                    await assert.rejects(() => handler[row.command](), row.expectRejection);
                } else {
                    response = await handler[row.command]();
                }
            } finally {
                console.log = originalLog;
            }

            row.verify({ handler, response, consoleLogs, warnings, filePath });
        });
    }
});
