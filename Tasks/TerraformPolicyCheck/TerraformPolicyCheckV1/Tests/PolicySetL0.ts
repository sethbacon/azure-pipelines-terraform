import * as assert from 'assert';
import { EventEmitter } from 'events';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import {
    assertNoTerraformImportOverride,
    evaluateSentinelSetOutput,
    runSentinelPolicySet,
    terraformImportBlocks,
} from '../src/sentinel-policy-set';
import {
    parsePoliciesFile,
    queryToDecisionPath,
    runOpaPolicySet,
    violationsOf,
} from '../src/opa-policy-set';

/**
 * hcpPolicySet: running an HCP Terraform policy set by that platform's rules.
 *
 * PROVENANCE: every Sentinel report under fixtures/policy-sets/ was produced by
 * Sentinel 0.41.0 (`sentinel apply -json`) against a real `terraform show -json`
 * plan, then reduced to the fields this task reads -- the trace, which carries
 * plan values and local paths, is dropped. The OPA output strings below have the
 * shape OPA 1.22.4's `opa exec` printed for the same plan.
 */
function fixture(name: string): { exitCode: number; stdout: string } {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-sets', `${name}.json`), 'utf-8'));
}

/** A captured report as the answer to one engine run. */
function sentinelRun(name: string): { code: number; stdout: string } {
    const { exitCode, stdout } = fixture(name);
    return { code: exitCode, stdout };
}

function opaOutput(result: unknown): string {
    return JSON.stringify({ result: [{ decision_id: '00000000-0000-0000-0000-000000000000', path: '/agent/_temp/opa-input/input.json', result }] });
}

describe('hcpPolicySet, Sentinel: reading the JSON report', function () {
    function evaluate(name: string, override = false) {
        const { exitCode, stdout } = fixture(name);
        return evaluateSentinelSetOutput(stdout, exitCode, override);
    }

    it('applies each policy\'s own level: hard-mandatory blocks, advisory warns', () => {
        const outcome = evaluate('sentinel-mixed-levels');
        assert.strictEqual(outcome.passed, false);
        assert.deepStrictEqual(outcome.blocking, ['[hard-mandatory] Policy failed: no-forbidden.']);
        assert.deepStrictEqual(outcome.nonBlocking, ['[advisory] Policy failed: advisory-fail.']);
        assert.deepStrictEqual(outcome.cases.map(c => [c.name, c.passed, c.enforcementLevel]), [
            ['advisory-fail', false, 'advisory'],
            ['has-files', true, 'soft-mandatory'],
            ['no-forbidden', false, 'hard-mandatory'],
        ]);
    });

    it('passes a run whose only failure is advisory, though Sentinel exits 1 for it', () => {
        const { exitCode } = fixture('sentinel-advisory-only-failure');
        assert.strictEqual(exitCode, 1, 'the fixture pins the reason the exit code cannot gate a policy set');
        const outcome = evaluate('sentinel-advisory-only-failure');
        assert.strictEqual(outcome.passed, true);
        assert.deepStrictEqual(outcome.blocking, []);
        assert.strictEqual(outcome.nonBlocking.length, 1);
    });

    it('a soft-mandatory failure blocks unless overridden; overriding never touches hard-mandatory', () => {
        assert.strictEqual(evaluate('sentinel-soft-mandatory-failure').passed, false);
        const overridden = evaluate('sentinel-soft-mandatory-failure', true);
        assert.strictEqual(overridden.passed, true);
        assert.deepStrictEqual(overridden.nonBlocking, ['[soft-mandatory] Policy failed: soft.']);
        assert.strictEqual(evaluate('sentinel-mixed-levels', true).passed, false);
    });

    it('an undefined result is a failure at the policy\'s level, with Sentinel\'s first line of explanation', () => {
        const outcome = evaluate('sentinel-undefined-result');
        assert.strictEqual(outcome.passed, false);
        assert.deepStrictEqual(outcome.blocking, ["[soft-mandatory] Policy failed: undef. Result value was 'undefined'."]);
    });

    it('a runtime error in an advisory policy warns and does not block', () => {
        const outcome = evaluate('sentinel-runtime-error-advisory');
        assert.strictEqual(outcome.passed, true);
        assert.match(outcome.nonBlocking[0], /^\[advisory\] Policy failed: rt\. /);
    });

    it('all policies passing is a pass', () => {
        const outcome = evaluate('sentinel-all-pass');
        assert.strictEqual(outcome.passed, true);
        assert.deepStrictEqual(outcome.violations, []);
    });

    // A run that evaluated nothing, or that this task cannot read, is never a pass.
    const refused: Array<[string, () => unknown, RegExp]> = [
        ['a set with no policies (Sentinel exits 0)', () => evaluate('sentinel-no-policies'), /evaluated no policies/],
        ['an invalid configuration', () => evaluate('sentinel-fatal-config'), /evaluated no policies[\s\S]*Fatal: could not read configuration file/],
        ['output that is not the JSON report', () => evaluateSentinelSetOutput('Policy installation failed', 1, false), /did not produce its JSON report/],
        ['an enforcement level it does not know', () => evaluateSentinelSetOutput(JSON.stringify({ result: true, policies: [{ policy: { name: 'a.sentinel', enforcement_level: 'mandatory' }, result: true }] }), 0, false), /cannot read/],
        ['a policy without a name', () => evaluateSentinelSetOutput(JSON.stringify({ result: true, policies: [{ policy: { enforcement_level: 'advisory' }, result: true }] }), 0, false), /cannot read/],
        ['a failure Sentinel exited 0 for', () => evaluateSentinelSetOutput(JSON.stringify({ result: true, policies: [{ policy: { name: 'a.sentinel', enforcement_level: 'advisory' }, result: false }] }), 0, false), /inconsistent/],
        ['a mandatory failure Sentinel called an overall pass', () => evaluateSentinelSetOutput(JSON.stringify({ result: true, policies: [{ policy: { name: 'a.sentinel', enforcement_level: 'hard-mandatory' }, result: false }] }), 1, false), /inconsistent/],
        ['an overall failure with no mandatory failure', () => evaluateSentinelSetOutput(JSON.stringify({ result: false, policies: [{ policy: { name: 'a.sentinel', enforcement_level: 'advisory' }, result: true }] }), 0, false), /inconsistent/],
    ];
    for (const [what, run, message] of refused) {
        it(`refuses ${what}`, () => assert.throws(run, message));
    }
});

describe('hcpPolicySet, Sentinel: the configuration the task adds', function () {
    it('enables the terraform feature and supplies the three imports from one plan, each under its own key', () => {
        const blocks = terraformImportBlocks('/agent/_temp/plan.json');
        assert.match(blocks, /sentinel \{\n {2}features = \{\n {4}terraform = true\n {2}\}\n\}/);
        for (const [name, key] of [['tfplan/v2', 'plan_path'], ['tfconfig/v2', 'path'], ['tfstate/v2', 'path']]) {
            assert.ok(blocks.includes(`import "plugin" "${name}" {\n  config = {\n    ${key} = "/agent/_temp/plan.json"\n  }\n}`), `${name}: ${blocks}`);
        }
    });

    it('escapes the plan path for HCL (a Windows path, a quote, an interpolation)', () => {
        const blocks = terraformImportBlocks('C:\\agent\\_temp\\"x"${y}.json');
        assert.ok(blocks.includes('plan_path = "C:\\\\agent\\\\_temp\\\\\\"x\\"$${y}.json"'), blocks);
    });

    for (const block of [
        'import "plugin" "tfplan/v2" {',
        '  import "static" "tfconfig/v2" {',
        'import "module" "tfstate/v2" {',
        'mock "tfplan/v2" {',
    ]) {
        it(`refuses a set whose own configuration supplies a Terraform import: ${block.trim()}`, () => {
            assert.throws(() => assertNoTerraformImportOverride(`policy "a" {\n  source = "./a.sentinel"\n}\n${block}\n}\n`), /configures the '.*' import itself/);
        });
    }

    it('accepts a set that only declares policies, modules and its own imports', () => {
        assert.doesNotThrow(() => assertNoTerraformImportOverride([
            '# import "plugin" "tfplan/v2" is supplied by the platform',
            'import "module" "tfplan-functions" {',
            '  source = "./modules/tfplan-functions.sentinel"',
            '}',
            'policy "a" {',
            '  source = "./a.sentinel"',
            '  enforcement_level = "hard-mandatory"',
            '}',
        ].join('\n')));
    });
});

describe('hcpPolicySet, OPA: reading policies.hcl', function () {
    it('reads policies, defaults the level to advisory, and ignores comments', () => {
        assert.deepStrictEqual(parsePoliciesFile([
            '# HCP Terraform policy set',
            'policy "no-public-buckets" {',
            '  query             = "data.terraform.buckets.deny" // the rule',
            '  enforcement_level = "mandatory"',
            '  description       = "Buckets must not be \\"public\\""',
            '}',
            '/* a block',
            '   comment */',
            'policy "tagging" {',
            '  query = "data.terraform.tags.deny"',
            '}',
        ].join('\n')), [
            { name: 'no-public-buckets', query: 'data.terraform.buckets.deny', enforcementLevel: 'mandatory', description: 'Buckets must not be "public"' },
            { name: 'tagging', query: 'data.terraform.tags.deny', enforcementLevel: 'advisory', description: undefined },
        ]);
    });

    const invalid: Array<[string, string, RegExp]> = [
        ['an empty file', '# nothing here\n', /declares no policies/],
        ['a policy without a query', 'policy "a" {\n}\n', /line 2: policy 'a' has no query/],
        ['a level OPA does not have', 'policy "a" {\n  query = "data.x.deny"\n  enforcement_level = "hard-mandatory"\n}\n', /advisory or mandatory/],
        ['a query that is not one rule', 'policy "a" {\n  query = "data.x.deny[_]"\n}\n', /must reference one rule/],
        ['a query outside data', 'policy "a" {\n  query = "input.plan"\n}\n', /must reference one rule/],
        ['a duplicate policy', 'policy "a" {\n  query = "data.x.deny"\n}\npolicy "a" {\n  query = "data.y.deny"\n}\n', /line 4: policy 'a' is declared more than once/],
        ['a repeated attribute', 'policy "a" {\n  query = "data.x.deny"\n  query = "data.y.deny"\n}\n', /set more than once/],
        ['an attribute it does not know', 'policy "a" {\n  query = "data.x.deny"\n  params = "x"\n}\n', /unsupported attribute 'params'/],
        ['a block it does not know', 'module "a" {\n}\n', /unsupported block 'module'/],
        ['an unquoted expression', 'policy "a" {\n  query = data.x.deny\n}\n', /line 2: unexpected '\.'/],
        ['a bare identifier as a value', 'policy "a" {\n  enforcement_level = mandatory\n}\n', /expected a quoted string for enforcement_level/],
        ['a template in a string', 'policy "a" {\n  query = "data.${x}.deny"\n}\n', /template expressions/],
        ['an unterminated string', 'policy "a" {\n  query = "data.x.deny\n}\n', /line 2: unterminated string/],
        ['an unterminated comment', 'policy "a" {\n/* never closed\n', /unterminated \/\* comment/],
        ['a number', 'policy "a" {\n  query = 3\n}\n', /line 2: unexpected '3'/],
        ['a missing closing brace', 'policy "a" {\n  query = "data.x.deny"\n', /closing policy "a"/],
    ];
    for (const [what, source, message] of invalid) {
        it(`refuses ${what}`, () => assert.throws(() => parsePoliciesFile(source), message));
    }

    it('turns a query into the decision path opa exec takes', () => {
        assert.strictEqual(queryToDecisionPath('data.terraform.policy1.deny'), 'terraform/policy1/deny');
    });

    it('applies HCP Terraform\'s rule: an array, which passes when empty', () => {
        const policy = { name: 'a', query: 'data.x.deny', enforcementLevel: 'mandatory' };
        assert.deepStrictEqual(violationsOf(policy, []), []);
        assert.deepStrictEqual(violationsOf(policy, ['bucket is public', { resource: 'x' }]), ['bucket is public', '{"resource":"x"}']);
        for (const notAnArray of [true, false, {}, { a: true }, 'deny', 0, null, undefined]) {
            assert.throws(() => violationsOf(policy, notAnArray), /requires a query to return an array/, JSON.stringify(notAnArray));
        }
    });
});

describe('hcpPolicySet: running a set', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = { tool: t.tool, getVariable: t.getVariable, getBoolInput: t.getBoolInput, error: t.error, warning: t.warning };

    let root: string;
    let agentTemp: string;
    let planFile: string;
    let runs: Array<{ args: string[]; options: Record<string, unknown>; config?: string; input?: string }>;
    let answer: (args: string[]) => { code: number; stdout: string };
    let errors: string[];
    let warnings: string[];
    let inputs: Record<string, boolean>;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-set-'));
        agentTemp = path.join(root, 'agent-temp');
        fs.mkdirSync(agentTemp);
        planFile = path.join(root, 'plan.json');
        fs.writeFileSync(planFile, '{"format_version":"1.2","resource_changes":[]}');
        runs = [];
        errors = [];
        warnings = [];
        inputs = {};
        t.getVariable = (name: string) => (name === 'Agent.TempDirectory' ? agentTemp : undefined);
        t.getBoolInput = (name: string) => inputs[name] === true;
        t.error = (message: string) => { errors.push(message); };
        t.warning = (message: string) => { warnings.push(message); };
        t.tool = () => {
            const runner = new EventEmitter() as EventEmitter & Record<string, unknown>;
            const args: string[] = [];
            runner.arg = (value: string | string[]) => { args.push(...([] as string[]).concat(value)); return runner; };
            runner.killChildProcess = () => { /* never times out here */ };
            runner.execAsync = async (options: Record<string, unknown>) => {
                // Read what the engine would read, while it still exists.
                const config = args.includes('-config') ? fs.readFileSync(args[args.indexOf('-config') + 1], 'utf-8') : undefined;
                const input = args[0] === 'exec' ? fs.readFileSync(args[args.length - 1], 'utf-8') : undefined;
                runs.push({ args: [...args], options, config, input });
                const { code, stdout } = answer(args);
                runner.emit('stdout', Buffer.from(stdout));
                return code;
            };
            return runner;
        };
    });

    afterEach(() => {
        Object.assign(t, taskOrig);
        fs.rmSync(root, { recursive: true, force: true });
    });

    function policySet(files: Record<string, string>): string {
        const dir = path.join(root, 'set');
        for (const [name, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            fs.writeFileSync(path.join(dir, name), content);
        }
        return dir;
    }

    describe('Sentinel', () => {
        const SET_CONFIG = 'policy "no-forbidden" {\n  source = "./no-forbidden.sentinel"\n  enforcement_level = "hard-mandatory"\n}\n';

        it('runs the set\'s own configuration plus the Terraform imports, from the set\'s directory, without echoing the report', async () => {
            const dir = policySet({ 'sentinel.hcl': SET_CONFIG });
            answer = () => sentinelRun('sentinel-all-pass');
            const tempFiles: string[] = [];
            const result = await runSentinelPolicySet('/usr/bin/sentinel', dir, planFile, tempFiles);

            assert.strictEqual(result.passed, true);
            assert.strictEqual(runs.length, 1);
            assert.deepStrictEqual(runs[0].args.slice(0, 3), ['apply', '-json', '-config']);
            assert.strictEqual(runs[0].options.cwd, dir, 'relative sources in sentinel.hcl resolve against the working directory');
            assert.strictEqual(runs[0].options.silent, true, 'the JSON report carries plan values');
            assert.strictEqual(runs[0].config, `${SET_CONFIG}\n${terraformImportBlocks(path.resolve(planFile))}`);
            assert.strictEqual(fs.readFileSync(path.join(dir, 'sentinel.hcl'), 'utf-8'), SET_CONFIG, 'the policy set is never written to');
            assert.strictEqual(tempFiles.length, 1);
            assert.ok(tempFiles[0].startsWith(agentTemp), 'the combined configuration lives in the agent temp directory');
        });

        it('reports a blocking failure as an error and a non-blocking one as a warning', async () => {
            const dir = policySet({ 'sentinel.hcl': SET_CONFIG });
            answer = () => sentinelRun('sentinel-mixed-levels');
            const result = await runSentinelPolicySet('/usr/bin/sentinel', dir, planFile, []);
            assert.strictEqual(result.passed, false);
            assert.deepStrictEqual(errors, ['[hard-mandatory] Policy failed: no-forbidden.']);
            assert.deepStrictEqual(warnings, ['[advisory] Policy failed: advisory-fail.']);
        });

        it('honours overrideSoftMandatory', async () => {
            const dir = policySet({ 'sentinel.hcl': SET_CONFIG });
            answer = () => sentinelRun('sentinel-soft-mandatory-failure');
            inputs.overrideSoftMandatory = true;
            assert.strictEqual((await runSentinelPolicySet('/usr/bin/sentinel', dir, planFile, [])).passed, true);
        });

        it('refuses a source with no sentinel.hcl, before running Sentinel', async () => {
            const dir = policySet({ 'a.sentinel': 'main = rule { true }\n' });
            await assert.rejects(() => runSentinelPolicySet('/usr/bin/sentinel', dir, planFile, []), /sentinel\.hcl does not exist/);
            assert.strictEqual(runs.length, 0);
        });

        it('refuses a set that supplies a Terraform import itself, before running Sentinel', async () => {
            const dir = policySet({ 'sentinel.hcl': `${SET_CONFIG}mock "tfplan/v2" {\n  module {\n    source = "./mock.sentinel"\n  }\n}\n` });
            await assert.rejects(() => runSentinelPolicySet('/usr/bin/sentinel', dir, planFile, []), /configures the 'tfplan\/v2' import itself/);
            assert.strictEqual(runs.length, 0);
        });
    });

    describe('OPA', () => {
        const SET = {
            'policies.hcl': 'policy "no-forbidden" {\n  query = "data.terraform.files.deny"\n  enforcement_level = "mandatory"\n}\npolicy "tagging" {\n  query = "data.terraform.files.warn"\n}\n',
            'policies/files.rego': 'package terraform.files\n',
        };

        it('evaluates each query against {"plan": <plan>}, applying each policy\'s level', async () => {
            const dir = policySet(SET);
            answer = args => (args.includes('terraform/files/deny')
                ? { code: 0, stdout: opaOutput(["local_file.bad: content must not be 'forbidden'"]) }
                : { code: 0, stdout: opaOutput(['local_file.bad: consider tagging']) });
            const tempFiles: string[] = [];
            const result = await runOpaPolicySet('/usr/bin/opa', dir, planFile, tempFiles);

            assert.deepStrictEqual(runs.map(r => r.args.slice(0, 5)), [
                ['exec', '--decision', 'terraform/files/deny', '--bundle', dir],
                ['exec', '--decision', 'terraform/files/warn', '--bundle', dir],
            ]);
            const input = JSON.parse(runs[0].input!);
            assert.deepStrictEqual(Object.keys(input), ['plan']);
            assert.deepStrictEqual(input.plan, JSON.parse(fs.readFileSync(planFile, 'utf-8')));
            assert.ok(tempFiles[0].startsWith(agentTemp));

            assert.strictEqual(result.passed, false);
            assert.deepStrictEqual(errors, ["[mandatory] no-forbidden: local_file.bad: content must not be 'forbidden'"]);
            assert.deepStrictEqual(warnings, ['[advisory] tagging: local_file.bad: consider tagging']);
            assert.deepStrictEqual(result.cases.map(c => [c.name, c.passed, c.enforcementLevel]), [['no-forbidden', false, 'mandatory'], ['tagging', false, 'advisory']]);
        });

        it('passes when every mandatory query returns an empty array', async () => {
            const dir = policySet(SET);
            answer = args => ({ code: 0, stdout: opaOutput(args.includes('terraform/files/deny') ? [] : ['advisory only']) });
            const result = await runOpaPolicySet('/usr/bin/opa', dir, planFile, []);
            assert.strictEqual(result.passed, true);
            assert.deepStrictEqual(errors, []);
            assert.strictEqual(warnings.length, 1);
        });

        it('fails on a query that names no rule, as OPA reports it', async () => {
            const dir = policySet(SET);
            answer = () => ({ code: 0, stdout: JSON.stringify({ result: [{ path: 'input.json', error: { code: 'opa_undefined_error', message: 'terraform/files/deny decision was undefined' } }] }) });
            await assert.rejects(() => runOpaPolicySet('/usr/bin/opa', dir, planFile, []), /decision was undefined/);
        });

        it('fails on a query that returns something other than an array', async () => {
            const dir = policySet(SET);
            answer = () => ({ code: 0, stdout: opaOutput(true) });
            await assert.rejects(() => runOpaPolicySet('/usr/bin/opa', dir, planFile, []), /requires a query to return an array/);
        });

        it('refuses a source with no policies.hcl, before running OPA', async () => {
            const dir = policySet({ 'policies/files.rego': 'package terraform.files\n' });
            await assert.rejects(() => runOpaPolicySet('/usr/bin/opa', dir, planFile, []), /policies\.hcl does not exist/);
            assert.strictEqual(runs.length, 0);
        });
    });
});
