import * as assert from 'assert';
import { EventEmitter } from 'events';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import ado = require('@4cloudguru/pipeline-task-ado');
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { TerraformCommandHandlerHCP } from '../src/hcp-terraform-command-handler';
import { MAX_POLICY_EVENTS, POLICY_PLUGIN_ENV, POLICY_RESULT_COMMANDS, PolicyEnforcement } from '../src/policy-enforcement';
import { buildPolicyCases, parsePolicyEvent, renderPolicyJUnit, summarizePolicyCases } from '../src/policy-results';

/**
 * Structured Terraform Policy results (`publishPolicyResults`).
 *
 * PROVENANCE OF THE FIXTURES: `SETUP_ERROR` is a line Terraform 1.17.2 actually
 * printed. Every other event is CONSTRUCTED from the field names in Terraform
 * v1.17.2's internal/command/views/json_view.go, because a real evaluation needs
 * an HCP Terraform organization entitled to policy enforcement. They pin this
 * task's reading of that source, not Terraform's observed behaviour.
 */
const SETUP_ERROR = '{"@level":"error","@message":"Error: Failed to setup Terraform Policy connection","@module":"terraform.ui","@policy":"true","@timestamp":"2026-11-16T19:53:30.409372-07:00","policy_diagnostic":{"severity":"error","summary":"Failed to setup Terraform Policy connection","detail":"Failed to setup Terraform Policy connection: rpc error: code = Unknown desc = entitlement check failed: client did not supply entitlement information."},"policy_metadata":{},"result":"SetupErrorResult","type":"policy_diagnostic"}';

function metadata(policy: string, level: string): Record<string, unknown> {
    return { policy_set_name: 'baseline', policy_set_path: '/policies', policy_name: policy, file_name: 'files.policy.hcl', enforcement_level: level };
}

function resultEvent(policy: string, target: string, result: string, level = 'mandatory'): string {
    return JSON.stringify({
        '@level': 'info', '@message': 'Policy Result', '@policy': 'true', type: 'policy_result',
        result, target_address: target, policy_address: policy, policy_metadata: metadata(policy, level),
    });
}

function diagnosticEvent(policy: string, target: string, severity: string, summary: string, detail: string, level = 'mandatory'): string {
    return JSON.stringify({
        '@level': severity, '@message': `Error: ${summary}`, '@policy': 'true', type: 'policy_diagnostic',
        policy_diagnostic: { severity, summary, detail }, target_address: target,
        policy_metadata: metadata(policy, level), result: 'DenyResult',
    });
}

const ENCRYPTED = 'resource_policy.local_file.no_forbidden';
const TAGGED = 'resource_policy.local_file.tagged';

const RUN = [
    '{"@level":"info","@message":"Terraform 1.17.2","type":"version"}',
    resultEvent(ENCRYPTED, 'local_file.good', 'AllowResult'),
    diagnosticEvent(ENCRYPTED, 'local_file.bad', 'error', 'Policy violation', "content must not be 'forbidden'"),
    resultEvent(ENCRYPTED, 'local_file.bad', 'DenyResult'),
    diagnosticEvent(TAGGED, 'local_file.bad', 'warning', 'Policy violation', 'files should be tagged', 'advisory'),
    resultEvent(TAGGED, 'local_file.bad', 'DenyResult', 'advisory'),
    resultEvent(TAGGED, 'local_file.later', 'UnknownResult', 'advisory'),
    '{"@level":"info","@message":"Plan: 3 to add","type":"change_summary"}',
];

/**
 * The same run without its mandatory violation: what Terraform can print and
 * still exit successfully. An error-level event on a successful exit is the
 * fail-open signature, and the step is failed for it (PolicyEnforcementL0).
 */
const PASSING_RUN = RUN.filter(line => !line.includes('"mandatory"') || line.includes('AllowResult'));

function casesOf(lines: string[]) {
    return buildPolicyCases(lines.map(parsePolicyEvent).filter((e): e is NonNullable<typeof e> => !!e));
}

describe('Terraform Policy results: reading the -json events', function () {
    it('ignores every line that is not a policy event', () => {
        for (const line of [RUN[0], RUN[7], 'Plan: 1 to add', '{"@policy":"true","type":"policy_query_summary"}', '{"@policy" not json', '']) {
            assert.strictEqual(parsePolicyEvent(line), undefined, line);
        }
    });

    it('reads the setup failure Terraform really prints', () => {
        assert.deepStrictEqual(parsePolicyEvent(SETUP_ERROR), {
            type: 'policy_diagnostic', result: 'SetupErrorResult', target: undefined, policy: undefined,
            policySet: undefined, enforcementLevel: undefined, severity: 'error',
            text: 'Failed to setup Terraform Policy connection: Failed to setup Terraform Policy connection: rpc error: code = Unknown desc = entitlement check failed: client did not supply entitlement information.',
        });
    });

    it('builds one case per policy and object, with its verdict, level and messages', () => {
        assert.deepStrictEqual(casesOf(RUN), [
            { name: `${ENCRYPTED} on local_file.good`, suite: 'baseline', outcome: 'passed', enforcementLevel: 'mandatory', messages: [] },
            { name: `${ENCRYPTED} on local_file.bad`, suite: 'baseline', outcome: 'failed', enforcementLevel: 'mandatory', messages: ["Policy violation: content must not be 'forbidden'"] },
            { name: `${TAGGED} on local_file.bad`, suite: 'baseline', outcome: 'failed', enforcementLevel: 'advisory', messages: ['Policy violation: files should be tagged'] },
            { name: `${TAGGED} on local_file.later`, suite: 'baseline', outcome: 'unknown', enforcementLevel: 'advisory', messages: [] },
        ]);
        assert.deepStrictEqual(summarizePolicyCases(casesOf(RUN)), { passed: 1, failed: 2, unknown: 1 });
    });

    // The rule that keeps a run which evaluated nothing from rendering as a pass.
    const notAPass: Array<[string, string[]]> = [
        ['an engine setup failure', [SETUP_ERROR]],
        ['an error diagnostic with no result event', [diagnosticEvent(ENCRYPTED, 'local_file.bad', 'error', 'Policy error', 'boom')]],
        ['a result name this task does not know', [resultEvent(ENCRYPTED, 'local_file.x', 'SomeFutureResult')]],
        ['a policy error result', [resultEvent(ENCRYPTED, 'local_file.x', 'PolicyErrorResult')]],
        ['a result event with no result field', [resultEvent(ENCRYPTED, 'local_file.x', '')]],
    ];
    for (const [what, lines] of notAPass) {
        it(`${what} is a failed case, never an empty or passing report`, () => {
            const cases = casesOf(lines);
            assert.strictEqual(cases.length, 1);
            assert.strictEqual(cases[0].outcome, 'failed');
        });
    }

    it('keeps the worse verdict when one address is evaluated twice (a replaced resource)', () => {
        for (const order of [['DenyResult', 'AllowResult'], ['AllowResult', 'DenyResult']]) {
            const cases = casesOf(order.map(r => resultEvent(ENCRYPTED, 'local_file.replaced', r)));
            assert.strictEqual(cases.length, 1);
            assert.strictEqual(cases[0].outcome, 'failed', order.join(' then '));
        }
    });

    it('a warning about a policy that has no result does not invent a verdict', () => {
        assert.deepStrictEqual(casesOf([diagnosticEvent(TAGGED, 'local_file.bad', 'warning', 'Heads up', 'x', 'advisory')]), []);
    });

    it('renders JUnit: failure with its level, skipped for unknown, escaped text', () => {
        const xml = renderPolicyJUnit(casesOf([...RUN, diagnosticEvent('p<1>', 'a"b', 'error', 'bad & worse', 'ctl\u0001char')]), 'Terraform Policy (plan)');
        assert.ok(xml.includes('<testsuite name="Terraform Policy (plan)" tests="5" failures="3" skipped="1">'), xml);
        assert.ok(xml.includes(`<testcase classname="baseline" name="${ENCRYPTED} on local_file.good"></testcase>`), xml);
        assert.ok(xml.includes('<failure message="[mandatory] Policy violation: content must not be &apos;forbidden&apos;">'), xml);
        assert.ok(xml.includes('<failure message="[advisory] Policy violation: files should be tagged">'), xml);
        assert.ok(xml.includes('<skipped message="[advisory] Not known until apply"/>'), xml);
        assert.ok(xml.includes('name="p&lt;1&gt; on a&quot;b"') && xml.includes('bad &amp; worse: ctlchar'), xml);
    });

    it('collects events from stdout only, up to the cap, and counts the rest', () => {
        const tool = new EventEmitter();
        const policy = new PolicyEnforcement([], true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an EventEmitter is all watch() uses of a ToolRunner
        policy.watch(tool as any);
        tool.emit('stderr', `${RUN[1]}\n`);
        assert.strictEqual(policy.events.length, 0, 'stderr is never the -json stream');
        const line = `${RUN[1]}\n`;
        tool.emit('stdout', line.repeat(MAX_POLICY_EVENTS + 3));
        tool.emit('stdout', RUN[3]); // no trailing newline
        policy.flush();
        assert.strictEqual(policy.events.length, MAX_POLICY_EVENTS);
        assert.strictEqual(policy.droppedEvents, 4);
    });
});

describe('Terraform Policy results: a real HCP Terraform run', function () {
    // fixtures/terraform-policy/plan-mandatory-json: `terraform plan -json -policies`
    // against HCP Terraform (Terraform 1.17.2, tfpolicy-plugin 0.5.0), one mandatory
    // failure, a policy whose value is not known until apply, and the rest passing.
    it('reads every policy result Terraform reported, with its level and message', () => {
        const run = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'terraform-policy', 'plan-mandatory-json.json'), 'utf-8'));
        const events = run.stdout.split('\n').map(parsePolicyEvent).filter((e: unknown) => e);
        const cases = buildPolicyCases(events);
        assert.deepStrictEqual(summarizePolicyCases(cases), { passed: 6, failed: 1, unknown: 2 });
        const failed = cases.find(c => c.outcome === 'failed')!;
        assert.strictEqual(failed.name, 'resource_policy.local_file.no_forbidden_content on local_file.bad[0]');
        assert.strictEqual(failed.enforcementLevel, 'mandatory');
        assert.deepStrictEqual(failed.messages, ["Condition not met: A file must not contain 'forbidden'."]);
        assert.ok(cases.some(c => c.name === 'provider_policy.local.supported_version on provider["registry.terraform.io/hashicorp/local"]' && c.outcome === 'passed'));
        assert.ok(cases.filter(c => c.outcome === 'unknown').every(c => c.name.startsWith('resource_policy.local_file.has_id on ')));
    });
});

describe('Terraform Policy results: publishing from plan, apply and destroy', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = { getInput: t.getInput, getBoolInput: t.getBoolInput, getVariable: t.getVariable, which: t.which, tool: t.tool, setVariable: t.setVariable, command: t.command, loc: t.loc, warning: t.warning };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared package
    const a = ado as any;
    const adoOrig = { readUrlInput: a.readUrlInput, readSecretInput: a.readSecretInput };
    const pluginEnvOrig = process.env[POLICY_PLUGIN_ENV];

    let root: string;
    let inputs: Record<string, string | undefined>;
    let argv: string[];
    let fakeTool: EventEmitter | undefined;
    let execs: string[];
    let variables: Record<string, string>;
    let published: Array<{ properties: Record<string, string>; xml: string }>;

    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-results-'));
        fs.mkdirSync(path.join(root, '.terraform'));
        fs.writeFileSync(path.join(root, '.terraform', 'terraform.tfstate'), JSON.stringify({ backend: { type: 'cloud', config: {} } }));
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    beforeEach(() => {
        inputs = {
            provider: 'azurerm',
            environmentServiceNameAzureRM: 'AzureRM',
            workingDirectory: root,
            policyPaths: 'policies',
            publishPolicyResults: 'true',
        };
        argv = [];
        execs = [];
        variables = {};
        published = [];
        fakeTool = undefined;
        process.env[POLICY_PLUGIN_ENV] = __filename;
        t.getInput = (name: string) => inputs[name];
        t.getBoolInput = (name: string) => inputs[name] === 'true';
        t.getVariable = (name: string) => (name === 'Agent.TempDirectory' ? root : undefined);
        t.setVariable = (name: string, value: string) => { variables[name] = value; };
        t.which = (tool: string) => (tool === 'terraform' ? 'terraform' : '');
        t.loc = (key: string, ...args: unknown[]) => `${key} ${args.join(' ')}`.trim();
        t.warning = () => { /* silence */ };
        t.command = (command: string, properties: Record<string, string>, file: string) => {
            if (command === 'results.publish') published.push({ properties, xml: fs.readFileSync(file, 'utf-8') });
        };
        t.tool = () => {
            const emitter = new EventEmitter();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake ToolRunner
            const runner: any = emitter;
            runner.arg = (value: string) => { argv.push(value); return runner; };
            runner.line = (value: string) => { argv.push(...value.split(' ')); return runner; };
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

    /** A handler whose terraform run prints `lines` on stdout and exits with `code`, recording which exec path ran. */
    function handlerPrinting(lines: string[], code = 0): TerraformCommandHandlerHCP {
        const handler = new TerraformCommandHandlerHCP();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- instance-level stubs, not shared across tests
        const h = handler as any;
        const stdout = lines.map(l => `${l}\n`).join('');
        h.warnIfMultipleProviders = async () => { /* would exec `terraform providers` */ };
        h.commandExecutor.execWithTimeout = async () => {
            execs.push('streamed');
            fakeTool!.emit('stdout', stdout);
            return code;
        };
        h.commandExecutor.execWithStdoutCapture = async (_tool: unknown, options: { silent?: boolean }) => {
            execs.push(options.silent ? 'captured-silent' : 'captured');
            fakeTool!.emit('stdout', stdout);
            return { code, stdout, stderr: '' };
        };
        return handler;
    }

    for (const command of [...POLICY_RESULT_COMMANDS]) {
        describe(command, () => {
            it('runs with -json, silently, and publishes one JUnit report with the outcomes', async () => {
                await handlerPrinting(PASSING_RUN).executeCommand(command);

                assert.strictEqual(argv.filter(v => v === '-json').length, 1, argv.join(' '));
                assert.deepStrictEqual(execs, ['captured-silent'], 'raw NDJSON must not reach the console');
                assert.strictEqual(published.length, 1);
                assert.deepStrictEqual(published[0].properties, { type: 'JUnit', mergeResults: 'true', runTitle: `Terraform Policy (${command})` });
                assert.ok(published[0].xml.includes('tests="3" failures="1" skipped="1"'), published[0].xml);
                // An advisory failure does not fail the step, but it is still a failed policy.
                assert.deepStrictEqual(variables.policyResult, 'failed');
                assert.deepStrictEqual(variables.policyViolationCount, '1');
            });

            it('does not add a second -json when commandOptions already has one', async () => {
                inputs.commandOptions = '-json';
                await handlerPrinting(PASSING_RUN).executeCommand(command);
                assert.strictEqual(argv.filter(v => v === '-json').length, 1, argv.join(' '));
                assert.deepStrictEqual(execs, ['captured-silent']);
            });

            it('still publishes when a mandatory policy fails the run, and still fails', async () => {
                await assert.rejects(() => handlerPrinting(RUN, 1).executeCommand(command));
                assert.strictEqual(published.length, 1);
                assert.ok(published[0].xml.includes('tests="4" failures="2" skipped="1"'), published[0].xml);
                assert.strictEqual(variables.policyViolationCount, '2');
            });

            it('reports a setup failure as a failed result, and the step fails', async () => {
                await assert.rejects(() => handlerPrinting([SETUP_ERROR]).executeCommand(command), /NOT fully checked/);
                assert.ok(published[0].xml.includes('name="Policy engine setup"') && published[0].xml.includes('failures="1"'), published[0].xml);
                assert.strictEqual(variables.policyResult, 'failed');
            });

            it('reports passed when every outcome passed', async () => {
                await handlerPrinting([RUN[1]]).executeCommand(command);
                assert.strictEqual(variables.policyResult, 'passed');
                assert.strictEqual(variables.policyViolationCount, '0');
            });

            it('reports none, and publishes nothing, when no policy applied to anything', async () => {
                await handlerPrinting([RUN[0], RUN[7]]).executeCommand(command);
                assert.strictEqual(published.length, 0);
                assert.strictEqual(variables.policyResult, 'none');
            });

            it('scrubs a tracked secret out of the published messages', async () => {
                EnvironmentVariableHelper.setEnvironmentVariable('POLICY_RESULTS_TEST_SECRET', 'hunter2-s3cr3t-value', true, true);
                await handlerPrinting([
                    diagnosticEvent(ENCRYPTED, 'local_file.bad', 'error', 'Policy violation', 'saw hunter2-s3cr3t-value in the content'),
                ], 1).executeCommand(command).catch(() => { /* asserting on the report */ });
                assert.strictEqual(published.length, 1);
                assert.ok(!published[0].xml.includes('hunter2-s3cr3t-value'), published[0].xml);
            });

            it('changes nothing when publishPolicyResults is off', async () => {
                inputs.publishPolicyResults = 'false';
                await handlerPrinting(PASSING_RUN).executeCommand(command);
                assert.ok(!argv.includes('-json'), argv.join(' '));
                assert.deepStrictEqual(execs, ['streamed']);
                assert.strictEqual(published.length, 0);
                assert.strictEqual(variables.policyResult, undefined);
            });

            it('changes nothing when no policies were requested', async () => {
                inputs.policyPaths = undefined;
                await handlerPrinting(PASSING_RUN).executeCommand(command);
                assert.ok(!argv.includes('-json'), argv.join(' '));
                assert.strictEqual(published.length, 0);
            });
        });
    }

    it('plan: refuses publishPlanResults, whose capture is the human-readable plan', async () => {
        inputs.publishPlanResults = 'my-plan';
        await assert.rejects(() => handlerPrinting(RUN).executeCommand('plan'), /PolicyResultsNotSupportedWithPublishPlanResults/);
        assert.deepStrictEqual(execs, []);
    });

    it('destroy with publishPlanSummary: the destroy itself still runs with -json and publishes', async () => {
        inputs.publishPlanSummary = 'my-destroy';
        const handler = handlerPrinting(PASSING_RUN);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- instance-level stubs
        const h = handler as any;
        h.runDestroyPlanForSummary = async () => { /* a separate `plan -destroy` */ };
        h.publishPlanSummaryAttachment = async () => { /* `show -json` of that plan */ };
        await handler.executeCommand('destroy');
        assert.strictEqual(argv.filter(v => v === '-json').length, 1, argv.join(' '));
        assert.deepStrictEqual(execs, ['captured-silent']);
        assert.strictEqual(published.length, 1);
    });

    it('init: publishPolicyResults does not apply', async () => {
        inputs.backendType = 'hcp';
        inputs.backendHCPToken = 'hcp-token';
        await handlerPrinting(PASSING_RUN).executeCommand('init');
        assert.ok(!argv.includes('-json'), argv.join(' '));
        assert.strictEqual(published.length, 0);
    });
});
