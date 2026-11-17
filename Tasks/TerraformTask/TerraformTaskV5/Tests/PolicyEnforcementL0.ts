import * as assert from 'assert';
import { EventEmitter } from 'events';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import ado = require('@4cloudguru/pipeline-task-ado');
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { TerraformCommandHandlerHCP } from '../src/hcp-terraform-command-handler';
import {
    POLICY_COMMANDS,
    POLICY_PLUGIN_ENV,
    PolicyEnforcement,
    isErrorDiagnosticLine,
    policyPathsInCommandOptions,
    preparePolicyEnforcement,
} from '../src/policy-enforcement';

/**
 * Terraform Policy (`-policies`). The lines under test were captured from
 * Terraform 1.17.2 with tfpolicy-plugin 0.5.0 against a local backend, where
 * `plan`, `apply` and `destroy` each printed the error below and then exited 0
 * having enforced nothing -- the behaviour these tests exist to keep failing.
 */
const ESC = '\u001b';
const HUMAN_COLOUR = `${ESC}[31m│${ESC}[0m ${ESC}[0m${ESC}[1m${ESC}[31mError: ${ESC}[0m${ESC}[0m${ESC}[1mFailed to setup Terraform Policy connection${ESC}[0m`;
const HUMAN_PLAIN = 'Error: Failed to connect to policy engine';
const JSON_EVENT = '{"@level":"error","@message":"Error: Failed to setup Terraform Policy connection","@module":"terraform.ui","@policy":"true","type":"policy_diagnostic"}';

const COMMANDS = [...POLICY_COMMANDS];

describe('Terraform Policy: -policies in commandOptions', function () {
    const cases: Array<[string | undefined, string[]]> = [
        [undefined, []],
        ['-out=tfplan -no-color', []],
        ['-policies=./pol', ['./pol']],
        ['--policies=./pol', ['./pol']],
        ['-policies ./pol', ['./pol']],
        ['-policies="my policies" -policies=b', ['my policies', 'b']],
        ['-policies', ['']],
        ['-var=policies=x -var-file=policies.tfvars', []],
    ];
    for (const [options, expected] of cases) {
        it(`${JSON.stringify(options)} -> ${JSON.stringify(expected)}`, () => {
            assert.deepStrictEqual(policyPathsInCommandOptions(options), expected);
        });
    }
});

describe('Terraform Policy: recognising an error diagnostic', function () {
    const cases: Array<['stdout' | 'stderr', string, boolean]> = [
        ['stderr', HUMAN_COLOUR, true],
        ['stderr', HUMAN_PLAIN, true],
        ['stderr', '│ Error: Invalid policy path', true],
        ['stdout', JSON_EVENT, true],
        // Human stdout is the plan: a multi-line attribute value may read like one.
        ['stdout', HUMAN_PLAIN, false],
        ['stdout', '      + content = "Error: not a diagnostic"', false],
        ['stderr', 'Warning: Policy advisory', false],
        ['stderr', 'detail mentioning Error: mid-line', false],
        ['stdout', '{"@level":"info","@message":"Error: quoted in a message"}', false],
        ['stderr', JSON_EVENT, false],
    ];
    for (const [stream, line, expected] of cases) {
        it(`${stream}: ${JSON.stringify(line.slice(0, 60))} -> ${expected}`, () => {
            assert.strictEqual(isErrorDiagnosticLine(stream, line), expected);
        });
    }
});

describe('Terraform Policy: the fail-open check', function () {
    function watched(active = true): { tool: EventEmitter; policy: PolicyEnforcement } {
        const tool = new EventEmitter();
        const policy = new PolicyEnforcement([], active);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an EventEmitter is all watch() uses of a ToolRunner
        policy.watch(tool as any);
        return { tool, policy };
    }

    it('passes a run that printed no error', () => {
        const { tool, policy } = watched();
        tool.emit('stdout', 'Plan: 1 to add, 0 to change, 0 to destroy.\n');
        tool.emit('stderr', 'Warning: something advisory\n');
        assert.doesNotThrow(() => policy.verify('plan'));
    });

    for (const [stream, line] of [['stderr', HUMAN_COLOUR], ['stderr', HUMAN_PLAIN], ['stdout', JSON_EVENT]] as const) {
        it(`fails a run that printed an error on ${stream} and still returned`, () => {
            const { tool, policy } = watched();
            tool.emit(stream, `first line\n${line}\nlast line\n`);
            assert.throws(() => policy.verify('apply'), /NOT fully checked against them\. The changes this step made stand\./);
        });
    }

    it('finds an error split across chunks, and one with no trailing newline', () => {
        const split = watched();
        split.tool.emit('stderr', Buffer.from('\nErr'));
        split.tool.emit('stderr', Buffer.from('or: Failed to connect to policy engine\n'));
        assert.throws(() => split.policy.verify('plan'), /Failed to connect to policy engine.*Do not apply a plan saved by this step/);

        const unterminated = watched();
        unterminated.tool.emit('stderr', HUMAN_PLAIN);
        assert.throws(() => unterminated.policy.verify('destroy'), /NOT fully checked/);
    });

    it('does nothing when no policies were requested', () => {
        const { tool, policy } = watched(false);
        assert.strictEqual(tool.listenerCount('stderr'), 0, 'an inactive run must not attach listeners');
        tool.emit('stderr', `${HUMAN_PLAIN}\n`);
        assert.doesNotThrow(() => policy.verify('plan'));
    });
});

/**
 * Real runs against HCP Terraform (Terraform 1.17.2, tfpolicy-plugin 0.5.0, a
 * workspace in Local execution mode, 2026-11-17) of one configuration and one
 * policy file with a mandatory, a mandatory_overridable and an advisory policy.
 * Recorded unedited apart from the agent path. They pin what the measurement
 * found: Terraform exits successfully from plan (2) and apply (0) however many
 * mandatory policies fail, so the step must fail on the diagnostic -- and must
 * say a policy failed, not that the policies were never checked.
 */
describe('Terraform Policy: real HCP Terraform runs', function () {
    function fixture(name: string): { command: string; exitCode: number; stdout: string; stderr: string } {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'terraform-policy', `${name}.json`), 'utf-8'));
    }

    function verified(name: string): void {
        const run = fixture(name);
        const tool = new EventEmitter();
        const policy = new PolicyEnforcement([], true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an EventEmitter is all watch() uses of a ToolRunner
        policy.watch(tool as any);
        tool.emit('stdout', run.stdout);
        tool.emit('stderr', run.stderr);
        policy.verify(run.command);
    }

    const cases: Array<[string, RegExp | null]> = [
        ['plan-clean-human', null],
        // Advisory: a Warning, not an Error. The step passes.
        ['plan-advisory-human', null],
        ['plan-advisory-json', null],
        ['plan-mandatory-human', /^1 mandatory policy check\(s\) failed: resource_policy\.local_file\.no_forbidden_content\. .*Do not apply a plan saved by this step\./],
        ['plan-mandatory-json', /^1 mandatory policy check\(s\) failed: resource_policy\.local_file\.no_forbidden_content on local_file\.bad\[0\]\. /],
        // mandatory_overridable fails like mandatory: a pipeline has no one to override it.
        ['plan-overridable-and-mandatory-colour', /^2 mandatory policy check\(s\) failed: resource_policy\.local_file\.short_content; resource_policy\.local_file\.no_forbidden_content\. /],
        // apply without a saved plan: the policy is evaluated after the change.
        ['apply-mandatory-human', /^1 mandatory policy check\(s\) failed: .*The changes this step made stand\./],
    ];
    for (const [name, failure] of cases) {
        it(`${name}: ${failure ? 'fails the step, naming the policy' : 'passes'}`, () => {
            if (!failure) {
                assert.doesNotThrow(() => verified(name));
                return;
            }
            assert.throws(() => verified(name), (err: Error) => {
                assert.match(err.message, failure);
                assert.ok(!/NOT fully checked/.test(err.message), `a failed policy is not an unchecked run: ${err.message}`);
                return true;
            });
        });
    }

    it('a policy failure and an engine that did not start are both reported', () => {
        const run = fixture('plan-mandatory-human');
        const tool = new EventEmitter();
        const policy = new PolicyEnforcement([], true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an EventEmitter is all watch() uses of a ToolRunner
        policy.watch(tool as any);
        tool.emit('stderr', `${run.stderr}${HUMAN_PLAIN}\n`);
        assert.throws(() => policy.verify('plan'), /Failed to connect to policy engine.*NOT fully checked.*1 mandatory policy check\(s\) failed/s);
    });

    it('names at most ten policies but counts every failure', () => {
        const tool = new EventEmitter();
        const policy = new PolicyEnforcement([], true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an EventEmitter is all watch() uses of a ToolRunner
        policy.watch(tool as any);
        for (let i = 0; i < 12; i++) {
            tool.emit('stderr', `│ Error: Condition not met\n│   on p.policy.hcl line 1, in resource_policy "t" "p${i}":\n`);
        }
        assert.throws(() => policy.verify('plan'), /12 mandatory policy check\(s\) failed: resource_policy\.t\.p0; .*resource_policy\.t\.p9; and 2 more\./);
    });

    it('a failure whose location never arrives is still counted', () => {
        const tool = new EventEmitter();
        const policy = new PolicyEnforcement([], true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an EventEmitter is all watch() uses of a ToolRunner
        policy.watch(tool as any);
        tool.emit('stderr', '│ Error: Condition not met\n│ Error: Condition not met\n');
        assert.throws(() => policy.verify('plan'), /2 mandatory policy check\(s\) failed: a policy; a policy\./);
    });
});

describe('Terraform Policy: guards and wiring for every command that accepts -policies', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = { getInput: t.getInput, getBoolInput: t.getBoolInput, getVariable: t.getVariable, which: t.which, tool: t.tool, setVariable: t.setVariable };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared package
    const a = ado as any;
    const adoOrig = { readUrlInput: a.readUrlInput, readSecretInput: a.readSecretInput };
    const pluginEnvOrig = process.env[POLICY_PLUGIN_ENV];

    let root: string;
    let hcpDir: string;
    let s3Dir: string;
    let inputs: Record<string, string | undefined>;
    let argv: Array<{ method: 'arg' | 'line'; value: string }>;
    let fakeTool: EventEmitter | undefined;
    let execCount: number;

    function initializedWith(backendType: string): string {
        const dir = fs.mkdtempSync(path.join(root, `${backendType}-`));
        fs.mkdirSync(path.join(dir, '.terraform'));
        fs.writeFileSync(path.join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({ backend: { type: backendType, config: {} } }));
        return dir;
    }

    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-enforcement-'));
        hcpDir = initializedWith('cloud');
        s3Dir = initializedWith('s3');
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    beforeEach(() => {
        inputs = {
            provider: 'azurerm',
            environmentServiceNameAzureRM: 'AzureRM',
            backendType: 'hcp',
            backendHCPToken: 'hcp-token',
            workingDirectory: hcpDir,
            policyPaths: 'policies\n../shared policies',
        };
        argv = [];
        fakeTool = undefined;
        execCount = 0;
        process.env[POLICY_PLUGIN_ENV] = __filename; // any file that exists
        t.getInput = (name: string) => inputs[name];
        t.getBoolInput = () => false;
        t.getVariable = () => undefined;
        t.setVariable = () => { /* plan sets changesPresent */ };
        t.which = (tool: string) => (tool === 'terraform' ? 'terraform' : '');
        t.tool = () => {
            const emitter = new EventEmitter();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake ToolRunner
            const runner: any = emitter;
            runner.arg = (value: string) => { argv.push({ method: 'arg', value }); return runner; };
            runner.line = (value: string) => { argv.push({ method: 'line', value }); return runner; };
            fakeTool = emitter;
            return runner;
        };
        a.readUrlInput = (name: string) => inputs[name];
        a.readSecretInput = (name: string) => inputs[name];
    });

    afterEach(() => {
        Object.assign(t, taskOrig);
        Object.assign(a, adoOrig);
        if (pluginEnvOrig === undefined) delete process.env[POLICY_PLUGIN_ENV]; else process.env[POLICY_PLUGIN_ENV] = pluginEnvOrig;
        EnvironmentVariableHelper.clearTrackedVariables();
    });

    /** A handler whose terraform "run" emits `stderr` and exits with `code`. */
    function handlerEmitting(stderr: string, code = 0): TerraformCommandHandlerHCP {
        const handler = new TerraformCommandHandlerHCP();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- instance-level stubs, not shared across tests
        const h = handler as any;
        h.warnIfMultipleProviders = async () => { /* would exec `terraform providers` */ };
        h.commandExecutor.execWithTimeout = async () => {
            execCount++;
            if (stderr) fakeTool!.emit('stderr', stderr);
            return code;
        };
        return handler;
    }

    for (const command of COMMANDS) {
        describe(command, () => {
            it('passes each policy path as one -policies token, ahead of commandOptions', async () => {
                inputs.commandOptions = command === 'apply' ? 'saved.tfplan' : '-no-color';
                await handlerEmitting('').executeCommand(command);

                const policyTokens = argv.filter(c => c.value.startsWith('-policies='));
                assert.deepStrictEqual(policyTokens, [
                    { method: 'arg', value: '-policies=policies' },
                    { method: 'arg', value: '-policies=../shared policies' },
                ]);
                if (command !== 'init') {
                    // A flag after the positional plan file is rejected by Terraform.
                    const firstPolicy = argv.findIndex(c => c.value.startsWith('-policies='));
                    const options = argv.findIndex(c => c.method === 'line');
                    assert.ok(firstPolicy < options, `-policies must precede commandOptions: ${JSON.stringify(argv)}`);
                }
                assert.strictEqual(execCount, 1);
            });

            it('fails when terraform printed an error and still exited successfully', async () => {
                await assert.rejects(
                    () => handlerEmitting(`${HUMAN_COLOUR}\n`).executeCommand(command),
                    new RegExp(`Terraform ${command} reported an error but still exited successfully.*NOT fully checked`),
                );
            });

            it('fails the same way when the policies came from commandOptions', async () => {
                inputs.policyPaths = undefined;
                inputs.commandOptions = '-policies=policies';
                await assert.rejects(() => handlerEmitting(`${HUMAN_PLAIN}\n`).executeCommand(command), /NOT fully checked/);
            });

            it('ignores the same output when no policies were requested', async () => {
                inputs.policyPaths = undefined;
                await handlerEmitting(`${HUMAN_PLAIN}\n`).executeCommand(command);
                assert.ok(!argv.some(c => c.value.includes('-policies')));
            });

            it('refuses a backend that is not HCP Terraform, without running terraform', async () => {
                inputs.backendType = 's3';
                inputs.workingDirectory = s3Dir;
                await assert.rejects(() => handlerEmitting('').executeCommand(command), /requires an HCP Terraform or Terraform Enterprise backend/);
                assert.strictEqual(execCount, 0);
            });

            it('refuses OpenTofu, without running it', async () => {
                inputs.binaryName = 'tofu';
                t.which = () => 'tofu';
                await assert.rejects(() => handlerEmitting('').executeCommand(command), /not available in 'tofu'/);
                assert.strictEqual(execCount, 0);
            });

            it('refuses when the policy engine cannot be found, without running terraform', async () => {
                process.env[POLICY_PLUGIN_ENV] = path.join(root, 'no-such-plugin');
                await assert.rejects(() => handlerEmitting('').executeCommand(command), /was not found at TF_POLICY_PLUGIN=/);
                delete process.env[POLICY_PLUGIN_ENV];
                await assert.rejects(() => handlerEmitting('').executeCommand(command), /was not found on the PATH/);
                assert.strictEqual(execCount, 0);
            });
        });
    }

    // `customCommand: plan` is the same Terraform run under another label.
    for (const [where, custom] of [
        ['commandOptions', { customCommand: 'plan', commandOptions: '-policies=policies' }],
        ['customCommand', { customCommand: 'apply -policies=policies', commandOptions: undefined }],
    ] as const) {
        describe(`custom, -policies in ${where}`, () => {
            beforeEach(() => {
                Object.assign(inputs, custom, { policyPaths: undefined, outputTo: 'console' });
            });

            it('fails when terraform printed an error and still exited successfully', async () => {
                await assert.rejects(() => handlerEmitting(`${HUMAN_COLOUR}\n`).executeCommand('custom'), /NOT fully checked/);
            });

            it('passes a clean run, adding no flag of its own', async () => {
                inputs.policyPaths = 'ignored-for-custom';
                await handlerEmitting('').executeCommand('custom');
                assert.ok(!argv.some(c => c.method === 'arg' && c.value.startsWith('-policies=')));
                assert.strictEqual(execCount, 1);
            });

            it('refuses a backend that is not HCP Terraform, without running terraform', async () => {
                inputs.workingDirectory = s3Dir;
                await assert.rejects(() => handlerEmitting('').executeCommand('custom'), /requires an HCP Terraform or Terraform Enterprise backend/);
                assert.strictEqual(execCount, 0);
            });
        });
    }

    it('finds the policy engine on the PATH when TF_POLICY_PLUGIN is unset', () => {
        delete process.env[POLICY_PLUGIN_ENV];
        t.which = (tool: string) => (tool === 'tfpolicy-plugin' ? '/opt/tfpolicy-plugin' : '');
        assert.strictEqual(preparePolicyEnforcement('plan', undefined, hcpDir, 'terraform').active, true);
    });

    it('does not read policyPaths for a command that has no -policies flag', () => {
        // A shared template may set the input on every step; validate has no such flag.
        assert.strictEqual(preparePolicyEnforcement('validate', undefined, s3Dir, 'terraform'), PolicyEnforcement.inactive);
    });
});
