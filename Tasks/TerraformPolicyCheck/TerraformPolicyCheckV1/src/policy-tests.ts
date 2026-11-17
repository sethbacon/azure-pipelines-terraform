import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import fs = require('fs');
import { PolicyCase, PolicyResult } from './types';
import { attachBoundedCapture } from './output-cap';
import { execWithTimeout, TOOL_EXEC_TIMEOUT_MS } from './exec-timeout';

/**
 * `mode: test` -- runs a policy repository's own tests and reports each test
 * case, so a broken policy fails its own pipeline instead of an infrastructure
 * one.
 *
 * Every engine below was run against passing, failing, erroring and empty test
 * suites (Sentinel 0.41.0, OPA 1.22.4, tfpolicy 0.5.0); what they do decides the
 * rules here. Three of their behaviours would read as a pass and are refused:
 *
 *   - `opa test` on a bundle with no tests prints `[]` and exits 0;
 *   - `tfpolicy test` finding no policies or no tests exits 0;
 *   - `sentinel test` reports a policy with no tests as status `?` and exits 0.
 *
 * So a run that produced no test case fails, and every engine's exit code must
 * agree with the cases parsed from its output.
 */

export const TEST_ENGINES: ReadonlySet<string> = new Set(['opa', 'sentinel', 'tfpolicy']);

export interface TestOutcome {
    cases: PolicyCase[];
    /** Sentinel policies that have no test cases. */
    untested: string[];
}

function failNoTests(engine: string, detail: string): never {
    throw new Error(
        `${engine} ran no tests; refusing to treat that as a pass. Check that the policy source holds the tests ` +
        `the engine looks for (see the engine's notes in the task documentation).${detail ? `\n${detail.slice(0, 2000)}` : ''}`,
    );
}

/**
 * The engine's exit code must agree with the cases read from its output. OPA
 * also exits non-zero when a test was only skipped (measured with OPA 1.22.4;
 * `--exit-zero-on-skipped` changes that but is not in every release a policy
 * set may pin), so for OPA a skipped test accounts for a non-zero exit too.
 */
function assertExitAgrees(engine: string, exitCode: number, cases: readonly PolicyCase[], skippedExitsNonZero = false): void {
    const failed = cases.filter(c => !c.passed && !c.skipped).length;
    const skipped = cases.filter(c => c.skipped).length;
    const expectNonZero = failed > 0 || (skippedExitsNonZero && skipped > 0);
    if ((exitCode !== 0) !== expectNonZero) {
        throw new Error(
            `${engine} exited with code ${exitCode} but ${failed} of ${cases.length} test case(s) failed; ` +
            `refusing to report a result the engine itself contradicts.`,
        );
    }
}

// --- Sentinel ----------------------------------------------------------------

interface SentinelTestCase { path?: unknown; status?: unknown; errors?: unknown; rule_detail?: unknown }
interface SentinelTestPolicy { path?: unknown; status?: unknown; errors?: unknown; cases?: Record<string, SentinelTestCase> | null }

function messagesOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v !== '');
    if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v !== '');
    }
    return [];
}

/** Reads `sentinel test -json`: one case per test file under test/<policy>/. */
export function parseSentinelTestReport(stdout: string, exitCode: number): TestOutcome {
    let report: { policies?: Record<string, SentinelTestPolicy> | null };
    try {
        report = JSON.parse(stdout);
    } catch {
        // Sentinel prints plain text, not JSON, when it cannot load the policies
        // or their test files, or finds no .sentinel file at all.
        throw new Error(`sentinel test did not produce its JSON report (exit code ${exitCode}):\n${stdout.slice(0, 2000)}`);
    }
    const policies = report && typeof report.policies === 'object' && report.policies ? report.policies : {};
    const cases: PolicyCase[] = [];
    const untested: string[] = [];
    for (const policyName of Object.keys(policies).sort()) {
        const policy = policies[policyName];
        const policyErrors = messagesOf(policy?.errors);
        const policyCases = policy?.cases && typeof policy.cases === 'object' ? policy.cases : {};
        const caseNames = Object.keys(policyCases).sort();
        if (policyErrors.length > 0) {
            cases.push({ group: policyName, name: policyName, passed: false, message: policyErrors.join('\n') });
        }
        if (caseNames.length === 0) {
            if (policyErrors.length === 0) untested.push(policyName);
            continue;
        }
        for (const caseName of caseNames) {
            const entry = policyCases[caseName];
            const status = typeof entry?.status === 'string' ? entry.status : '';
            if (status === 'PASS') {
                cases.push({ group: policyName, name: caseName, passed: true });
                continue;
            }
            const details = [...messagesOf(entry?.rule_detail), ...messagesOf(entry?.errors)];
            const message = details.length > 0 ? details.join('\n')
                : status === 'FAIL' ? 'The policy did not produce the result this test case expects (with no test block, it is expected to pass).'
                    : `Sentinel reported status '${status}' for this test case.`;
            cases.push({ group: policyName, name: caseName, passed: false, message });
        }
    }
    if (cases.length === 0) {
        failNoTests('sentinel test', untested.length ? `No test cases for: ${untested.join(', ')}. Sentinel looks for them in test/<policy>/*.hcl.` : '');
    }
    assertExitAgrees('sentinel test', exitCode, cases);
    return { cases, untested };
}

// --- OPA ---------------------------------------------------------------------

interface OpaTestEntry {
    location?: { file?: unknown; row?: unknown };
    package?: unknown;
    name?: unknown;
    fail?: unknown;
    skip?: unknown;
    error?: unknown;
}

/** Reads `opa test --format=json`: one case per test rule. */
export function parseOpaTestReport(stdout: string, exitCode: number): TestOutcome {
    let entries: OpaTestEntry[];
    try {
        entries = JSON.parse(stdout);
    } catch {
        throw new Error(`opa test did not produce its JSON report (exit code ${exitCode}):\n${stdout.slice(0, 2000)}`);
    }
    if (!Array.isArray(entries)) {
        throw new Error(`opa test produced JSON that is not a list of test results (exit code ${exitCode}).`);
    }
    const cases: PolicyCase[] = entries.map(entry => {
        const group = typeof entry.package === 'string' ? entry.package : 'opa';
        const name = typeof entry.name === 'string' ? entry.name : '(unnamed test)';
        const where = typeof entry.location?.file === 'string' ? ` (${entry.location.file}:${String(entry.location.row ?? '?')})` : '';
        if (entry.skip === true) return { group, name, passed: false, skipped: true };
        if (entry.error !== undefined && entry.error !== null) {
            const error = entry.error as { message?: unknown };
            return { group, name, passed: false, message: `Error${where}: ${typeof error.message === 'string' ? error.message : JSON.stringify(entry.error)}` };
        }
        if (entry.fail === true) return { group, name, passed: false, message: `Test failed${where}.` };
        return { group, name, passed: true };
    });
    if (cases.filter(c => !c.skipped).length === 0) {
        failNoTests('opa test', 'OPA runs the rules whose names start with test_, in the policy source.');
    }
    assertExitAgrees('opa test', exitCode, cases, true);
    return { cases, untested: [] };
}

// --- tfpolicy ----------------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;
const TFPOLICY_LINE = /^( *)# (.+)\.\.\. (running|pass|fail)$/;

/**
 * Reads `tfpolicy test`'s human output, its only format:
 *
 *      # tests/files.policytest.hcl... running
 *        # resource.local_file.good... running
 *        # resource.local_file.good... pass
 *      # tests/files.policytest.hcl... pass
 *
 * Case names are not unique -- every provider case of one type is named
 * `provider.<type>` -- so cases are matched in order, and a repeated name is
 * numbered. A case that started and never finished fails, and so does a test
 * file that failed with no failed case of its own.
 */
export function parseTfpolicyTestOutput(stdout: string, exitCode: number): TestOutcome {
    const cases: PolicyCase[] = [];
    let file = '';
    const open: PolicyCase[] = [];
    const seen = new Map<string, number>();

    for (const raw of stdout.split('\n')) {
        const match = TFPOLICY_LINE.exec(raw.replace(ANSI, '').trimEnd());
        if (!match) continue;
        const [, indent, name, state] = match;
        if (indent.length <= 1) {
            if (state === 'running') {
                file = name;
                seen.clear();
            } else if (state === 'fail' && !cases.some(c => c.group === name && !c.passed)) {
                cases.push({ group: name, name, passed: false, message: 'The test file failed; Terraform Policy\'s diagnostics are in the step log.' });
            }
            continue;
        }
        if (state === 'running') {
            const count = (seen.get(name) ?? 0) + 1;
            seen.set(name, count);
            const entry: PolicyCase = { group: file, name: count > 1 ? `${name} #${count}` : name, passed: false, message: 'The test case started but never finished.' };
            cases.push(entry);
            open.push(entry);
            continue;
        }
        const index = open.findIndex(c => c.group === file && (c.name === name || c.name.startsWith(`${name} #`)));
        if (index === -1) continue;
        const [entry] = open.splice(index, 1);
        entry.passed = state === 'pass';
        entry.message = entry.passed ? undefined : 'Failed; Terraform Policy\'s diagnostics are in the step log.';
    }

    if (cases.length === 0) {
        failNoTests('tfpolicy test', stdout.replace(ANSI, '').trim());
    }
    assertExitAgrees('tfpolicy test', exitCode, cases);
    return { cases, untested: [] };
}

/** `tfpolicy test` searches one directory each for policies and tests; both must be inside the policy source. */
export function resolveTfpolicyDirs(policyDir: string): { policies: string; tests: string } {
    const resolve = (input: string, fallback: string): string => {
        const value = tasks.getInput(input, false) || fallback;
        const dir = path.resolve(policyDir, value);
        if (dir !== policyDir && !dir.startsWith(policyDir + path.sep)) {
            throw new Error(`${input} '${value}' points outside the policy source.`);
        }
        if (!fs.existsSync(dir)) {
            throw new Error(`${input} '${value}' does not exist in the policy source (${dir}).`);
        }
        return dir;
    };
    return { policies: resolve('tfpolicyPoliciesDir', 'policies'), tests: resolve('tfpolicyTestsDir', 'tests') };
}

// --- running -----------------------------------------------------------------

export async function runPolicyTests(engine: string, agentPath: string, policyDir: string): Promise<PolicyResult> {
    const tool = tasks.tool(agentPath);
    let silent = true;
    if (engine === 'sentinel') {
        tool.arg(['test', '-json']);
    } else if (engine === 'opa') {
        // --bundle: load the policies exactly as evaluation does.
        tool.arg(['test', '--bundle', '--format=json', policyDir]);
    } else {
        const dirs = resolveTfpolicyDirs(policyDir);
        tool.arg(['test', `--policies=${dirs.policies}`, `--tests=${dirs.tests}`]);
        // Its human output is its only format, and the readable log.
        silent = false;
    }

    let stdout = '';
    let stderr = '';
    const capture = attachBoundedCapture(tool, (stream, text) => {
        if (stream === 'stdout') stdout += text; else stderr += text;
    });
    const code = await execWithTimeout(
        tool,
        <IExecOptions>{ cwd: policyDir, ignoreReturnCode: true, silent },
        tasks.loc('PolicyEngineTimedOut', `${engine} test`, TOOL_EXEC_TIMEOUT_MS),
    );
    capture.assertWithinCap();

    let outcome: TestOutcome;
    try {
        outcome = engine === 'sentinel' ? parseSentinelTestReport(stdout, code)
            : engine === 'opa' ? parseOpaTestReport(stdout, code)
                : parseTfpolicyTestOutput(stdout, code);
    } catch (err) {
        const detail = silent && stderr.trim() ? `\n${stderr.replace(ANSI, '').trim().slice(0, 2000)}` : '';
        throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
    }

    for (const c of outcome.cases) {
        console.log(`${c.skipped ? 'SKIP' : c.passed ? 'PASS' : 'FAIL'} - ${c.group} - ${c.name}`);
    }
    const failed = outcome.cases.filter(c => !c.passed && !c.skipped);
    const violations = failed.map(c => `Policy test failed: ${c.group} - ${c.name}${c.message ? `: ${c.message}` : ''}`);
    for (const v of violations) tasks.error(v);
    for (const policy of outcome.untested) tasks.warning(`Sentinel policy ${policy} has no tests (test/${policy.replace(/\.sentinel$/, '')}/*.hcl).`);

    return { passed: failed.length === 0, violations, cases: outcome.cases, rawOutput: stdout };
}
