import * as assert from 'assert';
import { EventEmitter } from 'events';
import fs = require('fs');
import os = require('os');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import {
    parseOpaTestReport,
    parseSentinelTestReport,
    parseTfpolicyTestOutput,
    resolveTfpolicyDirs,
    runPolicyTests,
} from '../src/policy-tests';
import { writeJUnit } from '../src/results';

/**
 * `mode: test`.
 *
 * PROVENANCE: every file under fixtures/policy-tests/ is the real output and
 * exit code of `sentinel test -json` (Sentinel 0.41.0), `opa test --bundle
 * --format=json` (OPA 1.22.4) or `tfpolicy test` (tfpolicy 0.5.0, colour codes
 * and all) run against small suites with passing, failing, erroring, skipped and
 * missing tests. Sentinel's per-case `trace` is dropped; nothing else is edited.
 */
function fixture(name: string): { exitCode: number; stdout: string } {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-tests', `${name}.json`), 'utf-8'));
}

function summary(cases: Array<{ group?: string; name: string; passed: boolean; skipped?: boolean }>): string[] {
    return cases.map(c => `${c.skipped ? 'SKIP' : c.passed ? 'PASS' : 'FAIL'} ${c.group} :: ${c.name}`);
}

describe('mode test, Sentinel: reading sentinel test -json', function () {
    it('reports one case per test file, with the expectation that failed', () => {
        const { exitCode, stdout } = fixture('sentinel-failures');
        const { cases, untested } = parseSentinelTestReport(stdout, exitCode);
        assert.deepStrictEqual(summary(cases), [
            'PASS has-tag.sentinel :: test/has-tag/default.hcl',
            'FAIL has-tag.sentinel :: test/has-tag/wrong-owner.hcl',
            'PASS no-forbidden.sentinel :: test/no-forbidden/fail-expected.hcl',
            'FAIL no-forbidden.sentinel :: test/no-forbidden/fail-unexpected.hcl',
            'PASS no-forbidden.sentinel :: test/no-forbidden/pass.hcl',
        ]);
        assert.strictEqual(cases[1].message, 'expected "main" to be true, got: false');
        assert.match(cases[3].message!, /with no test block, it is expected to pass/);
        assert.deepStrictEqual(untested, []);
    });

    it('passes a suite whose cases all pass', () => {
        const { exitCode, stdout } = fixture('sentinel-all-pass');
        assert.ok(parseSentinelTestReport(stdout, exitCode).cases.every(c => c.passed));
    });

    it('lists a policy with no tests (Sentinel calls it ? and exits 0) without counting it as a pass', () => {
        const { exitCode, stdout } = fixture('sentinel-untested-policy');
        assert.strictEqual(exitCode, 0);
        const { cases, untested } = parseSentinelTestReport(stdout, exitCode);
        assert.deepStrictEqual(untested, ['untested.sentinel']);
        assert.ok(!cases.some(c => c.group === 'untested.sentinel'));
    });

    it('a case that errors is a failure carrying Sentinel\'s error', () => {
        const { exitCode, stdout } = fixture('sentinel-runtime-error');
        const { cases } = parseSentinelTestReport(stdout, exitCode);
        assert.strictEqual(cases.length, 1);
        assert.strictEqual(cases[0].passed, false);
        assert.match(cases[0].message!, /Import "tfplan\/v2" is not available/);
    });

    it('refuses plain-text output (no .sentinel files, or a test file it cannot load)', () => {
        const { exitCode, stdout } = fixture('sentinel-no-files');
        assert.throws(() => parseSentinelTestReport(stdout, exitCode), /did not produce its JSON report[\s\S]*No Sentinel files were found/);
    });

    it('refuses a run with no test cases at all', () => {
        const report = JSON.stringify({ policies: { 'a.sentinel': { path: 'a.sentinel', status: '?', errors: null, cases: {} } }, duration: 0 });
        assert.throws(() => parseSentinelTestReport(report, 0), /ran no tests[\s\S]*No test cases for: a\.sentinel/);
    });

    it('refuses an exit code that contradicts the cases', () => {
        const { stdout } = fixture('sentinel-all-pass');
        assert.throws(() => parseSentinelTestReport(stdout, 1), /exited with code 1 but 0 of/);
        const failures = fixture('sentinel-failures');
        assert.throws(() => parseSentinelTestReport(failures.stdout, 0), /exited with code 0 but 2 of 5/);
    });

    it('a case status it does not know is a failure', () => {
        const report = JSON.stringify({ policies: { 'a.sentinel': { cases: { 'test/a/x.hcl': { status: 'WEIRD' } } } } });
        const { cases } = parseSentinelTestReport(report, 1);
        assert.strictEqual(cases[0].passed, false);
        assert.match(cases[0].message!, /status 'WEIRD'/);
    });
});

describe('mode test, OPA: reading opa test --format=json', function () {
    it('reports one case per test rule: failed, skipped, passed', () => {
        const { exitCode, stdout } = fixture('opa-failures');
        const { cases } = parseOpaTestReport(stdout, exitCode);
        assert.deepStrictEqual(summary(cases), [
            'SKIP data.terraform.files_test :: todo_test_later',
            'FAIL data.terraform.files_test :: test_errors',
            'FAIL data.terraform.files_test :: test_deliberately_wrong',
            'PASS data.terraform.files_test :: test_fine_allowed',
            'PASS data.terraform.files_test :: test_forbidden_denied',
        ]);
        assert.match(cases[2].message!, /Test failed \(policies\/files_test\.rego:14\)/);
    });

    it('passes a suite whose tests pass (exit 0)', () => {
        const { exitCode, stdout } = fixture('opa-all-pass');
        assert.strictEqual(exitCode, 0);
        assert.ok(parseOpaTestReport(stdout, exitCode).cases.every(c => c.passed));
    });

    it('passes a suite whose only non-pass is a skipped test, though OPA exits 2 for it', () => {
        const { exitCode, stdout } = fixture('opa-pass-with-skipped');
        assert.strictEqual(exitCode, 2, 'the fixture pins why a skipped test must account for a non-zero exit');
        const { cases } = parseOpaTestReport(stdout, exitCode);
        assert.ok(cases.some(c => c.skipped));
        assert.ok(!cases.some(c => !c.passed && !c.skipped));
    });

    it('refuses a bundle with no tests (OPA prints [] and exits 0)', () => {
        const { exitCode, stdout } = fixture('opa-no-tests');
        assert.strictEqual(exitCode, 0);
        assert.throws(() => parseOpaTestReport(stdout, exitCode), /opa test ran no tests/);
    });

    it('refuses a load error (no JSON on stdout)', () => {
        const { exitCode, stdout } = fixture('opa-load-error');
        assert.throws(() => parseOpaTestReport(stdout, exitCode), /did not produce its JSON report \(exit code 1\)/);
    });

    it('a test with an error is a failure carrying the message', () => {
        const report = JSON.stringify([{ package: 'data.p_test', name: 'test_x', error: { message: 'eval_conflict_error' }, location: { file: 'p_test.rego', row: 3 } }]);
        const { cases } = parseOpaTestReport(report, 2);
        assert.strictEqual(cases[0].passed, false);
        assert.strictEqual(cases[0].message, 'Error (p_test.rego:3): eval_conflict_error');
    });

    it('refuses JSON that is not a list, and an exit that contradicts the cases', () => {
        assert.throws(() => parseOpaTestReport('{"result":[]}', 0), /not a list/);
        assert.throws(() => parseOpaTestReport(fixture('opa-all-pass').stdout, 2), /exited with code 2 but 0 of/);
        assert.throws(() => parseOpaTestReport(fixture('opa-failures').stdout, 0), /exited with code 0 but 2 of/);
    });
});

describe('mode test, Terraform Policy: reading tfpolicy test', function () {
    it('reports one case per mocked object, numbering repeated names', () => {
        const { exitCode, stdout } = fixture('tfpolicy-failures');
        assert.ok(stdout.includes('\u001b['), 'tfpolicy colours its output even when not on a terminal');
        const { cases } = parseTfpolicyTestOutput(stdout, exitCode);
        assert.deepStrictEqual(summary(cases), [
            'PASS tests/files.policytest.hcl :: resource.local_file.good',
            'PASS tests/files.policytest.hcl :: resource.local_file.bad_expected',
            'FAIL tests/files.policytest.hcl :: resource.local_file.bad_unexpected',
            'PASS tests/providers.policytest.hcl :: provider.local',
            'PASS tests/providers.policytest.hcl :: provider.local #2',
        ]);
    });

    it('passes a suite whose cases all pass', () => {
        const { exitCode, stdout } = fixture('tfpolicy-all-pass');
        const { cases } = parseTfpolicyTestOutput(stdout, exitCode);
        assert.strictEqual(cases.length, 4);
        assert.ok(cases.every(c => c.passed));
    });

    it('refuses "No tests to execute" (tfpolicy exits 0 for it)', () => {
        const { exitCode, stdout } = fixture('tfpolicy-no-tests');
        assert.strictEqual(exitCode, 0);
        assert.throws(() => parseTfpolicyTestOutput(stdout, exitCode), /tfpolicy test ran no tests[\s\S]*No tests to execute/);
    });

    it('refuses a run that could not read its files', () => {
        const { exitCode, stdout } = fixture('tfpolicy-load-error');
        assert.throws(() => parseTfpolicyTestOutput(stdout, exitCode), /ran no tests[\s\S]*Failed to read Terraform Policy files and tests/);
    });

    it('a case that started and never finished is a failure', () => {
        const out = ' # tests/a.policytest.hcl... running\n   # resource.x.y... running\n';
        const { cases } = parseTfpolicyTestOutput(out, 1);
        assert.deepStrictEqual(summary(cases), ['FAIL tests/a.policytest.hcl :: resource.x.y']);
        assert.match(cases[0].message!, /never finished/);
    });

    it('a test file that failed with no failed case of its own is a failure', () => {
        const out = ' # tests/a.policytest.hcl... running\n   # resource.x.y... running\n   # resource.x.y... pass\n # tests/a.policytest.hcl... fail\n';
        const { cases } = parseTfpolicyTestOutput(out, 1);
        assert.deepStrictEqual(summary(cases), ['PASS tests/a.policytest.hcl :: resource.x.y', 'FAIL tests/a.policytest.hcl :: tests/a.policytest.hcl']);
    });

    it('refuses an exit code that contradicts the cases', () => {
        assert.throws(() => parseTfpolicyTestOutput(fixture('tfpolicy-all-pass').stdout, 1), /exited with code 1 but 0 of 4/);
    });
});

describe('mode test, Terraform Policy: where the policies and tests are', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const getInput = t.getInput;
    let root: string;
    let inputs: Record<string, string | undefined>;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpolicy-dirs-'));
        fs.mkdirSync(path.join(root, 'policies'));
        fs.mkdirSync(path.join(root, 'tests'));
        inputs = {};
        t.getInput = (name: string) => inputs[name];
    });
    afterEach(() => {
        t.getInput = getInput;
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('defaults to HashiCorp\'s layout: policies/ and tests/', () => {
        assert.deepStrictEqual(resolveTfpolicyDirs(root), { policies: path.join(root, 'policies'), tests: path.join(root, 'tests') });
    });

    it('accepts tests kept beside the policies', () => {
        inputs.tfpolicyTestsDir = 'policies';
        assert.strictEqual(resolveTfpolicyDirs(root).tests, path.join(root, 'policies'));
    });

    for (const outside of ['..', '../elsewhere', '/etc', 'policies/../../x']) {
        it(`refuses a directory outside the policy source: ${outside}`, () => {
            inputs.tfpolicyPoliciesDir = outside;
            assert.throws(() => resolveTfpolicyDirs(root), /points outside the policy source/);
        });
    }

    it('refuses a directory that does not exist', () => {
        inputs.tfpolicyTestsDir = 'test';
        assert.throws(() => resolveTfpolicyDirs(root), /tfpolicyTestsDir 'test' does not exist/);
    });
});

describe('mode test: running each engine', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = { tool: t.tool, getInput: t.getInput, error: t.error, warning: t.warning };
    let root: string;
    let runs: Array<{ args: string[]; options: Record<string, unknown> }>;
    let answer: { exitCode: number; stdout: string };
    let errors: string[];
    let warnings: string[];

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-tests-run-'));
        fs.mkdirSync(path.join(root, 'policies'));
        fs.mkdirSync(path.join(root, 'tests'));
        runs = [];
        errors = [];
        warnings = [];
        t.getInput = () => undefined;
        t.error = (m: string) => { errors.push(m); };
        t.warning = (m: string) => { warnings.push(m); };
        t.tool = () => {
            const runner = new EventEmitter() as EventEmitter & Record<string, unknown>;
            const args: string[] = [];
            runner.arg = (value: string | string[]) => { args.push(...([] as string[]).concat(value)); return runner; };
            runner.killChildProcess = () => { /* never times out here */ };
            runner.execAsync = async (options: Record<string, unknown>) => {
                runs.push({ args: [...args], options });
                runner.emit('stdout', Buffer.from(answer.stdout));
                return answer.exitCode;
            };
            return runner;
        };
    });
    afterEach(() => {
        Object.assign(t, taskOrig);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const engines: Array<[string, string, string[], boolean]> = [
        // [engine, fixture, expected args, silent]
        ['sentinel', 'sentinel-failures', ['test', '-json'], true],
        ['opa', 'opa-failures', ['test', '--bundle', '--format=json', '<root>'], true],
        ['tfpolicy', 'tfpolicy-failures', ['test', '--policies=<root:policies>', '--tests=<root:tests>'], false],
    ];
    for (const [engine, name, args, silent] of engines) {
        it(`${engine}: runs from the policy source with the engine's arguments and reports each failure`, async () => {
            answer = fixture(name);
            const result = await runPolicyTests(engine, `/usr/bin/${engine}`, root);
            // path.join, not '/': the task builds these with the platform separator.
            const expected = args.map(a => a.replace(/<root(?::(\w+))?>/, (_m, sub) => (sub ? path.join(root, sub) : root)));
            assert.deepStrictEqual(runs[0].args, expected);
            assert.strictEqual(runs[0].options.cwd, root);
            assert.strictEqual(runs[0].options.silent, silent, silent ? 'JSON reports stay out of the log' : 'tfpolicy\'s own output is the readable log');
            assert.strictEqual(result.passed, false);
            assert.strictEqual(errors.length, result.violations.length);
            assert.ok(result.violations.length > 0);
            assert.ok(errors.every(e => e.startsWith('Policy test failed: ')));
        });
    }

    it('warns about a Sentinel policy with no tests', async () => {
        answer = fixture('sentinel-untested-policy');
        const result = await runPolicyTests('sentinel', '/usr/bin/sentinel', root);
        assert.strictEqual(result.passed, true);
        assert.deepStrictEqual(warnings, ['Sentinel policy untested.sentinel has no tests (test/untested/*.hcl).']);
    });
});

describe('mode test: the JUnit report', function () {
    it('groups cases by policy, marks skipped tests skipped, and counts only real failures', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-tests-junit-'));
        const tempDirOrig = (tasks as unknown as { getVariable: unknown }).getVariable;
        (tasks as unknown as { getVariable: (n: string) => string | undefined }).getVariable = (n: string) => (n === 'Agent.TempDirectory' ? dir : undefined);
        try {
            const { exitCode, stdout } = fixture('opa-failures');
            const xml = fs.readFileSync(writeJUnit(parseOpaTestReport(stdout, exitCode).cases, 'opa', 'Policy tests (opa)'), 'utf-8');
            assert.ok(xml.includes('<testsuite name="Policy tests (opa)" tests="5" failures="2" skipped="1">'), xml);
            assert.ok(xml.includes('<testcase classname="data.terraform.files_test" name="todo_test_later">\n      <skipped/>\n    </testcase>'), xml);
            assert.ok(xml.includes('<testcase classname="data.terraform.files_test" name="test_fine_allowed"></testcase>'), xml);
        } finally {
            (tasks as unknown as { getVariable: unknown }).getVariable = tempDirOrig;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('leaves the evaluation report unchanged: no group, no skipped attribute, the same title', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-eval-junit-'));
        const tempDirOrig = (tasks as unknown as { getVariable: unknown }).getVariable;
        (tasks as unknown as { getVariable: (n: string) => string | undefined }).getVariable = (n: string) => (n === 'Agent.TempDirectory' ? dir : undefined);
        try {
            const xml = fs.readFileSync(writeJUnit([{ name: 'terraform/deny', passed: true }, { name: 'terraform/deny[0]', passed: false, message: 'm' }], 'opa'), 'utf-8');
            assert.strictEqual(xml, [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<testsuites>',
                '  <testsuite name="Terraform Policy Check (opa)" tests="2" failures="1">',
                '    <testcase classname="Terraform Policy Check (opa)" name="terraform/deny"></testcase>',
                '    <testcase classname="Terraform Policy Check (opa)" name="terraform/deny[0]">',
                '      <failure message="m">m</failure>',
                '    </testcase>',
                '  </testsuite>',
                '</testsuites>',
                '',
            ].join('\n'));
        } finally {
            (tasks as unknown as { getVariable: unknown }).getVariable = tempDirOrig;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
