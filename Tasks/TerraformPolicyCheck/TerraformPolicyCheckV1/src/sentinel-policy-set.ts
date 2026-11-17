import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { writeSecretFile } from '@4cloudguru/pipeline-task-ado';
import { PolicyResult, PolicyCase } from './types';
import { attachBoundedCapture } from './output-cap';
import { execWithTimeout, TOOL_EXEC_TIMEOUT_MS } from './exec-timeout';
import { hcl } from './sentinel-engine';
import { withFreshSentinelCache } from './sentinel-cache';

/**
 * Evaluates an HCP Terraform Sentinel policy set as HCP Terraform would
 * (`hcpPolicySet`).
 *
 * The policy source is the root of a policy set: its own `sentinel.hcl` names
 * the policies, their enforcement levels, their parameters and the modules they
 * import. Nothing in it is rewritten. The task appends only what HCP Terraform
 * supplies from the run:
 *
 *   - the `terraform` feature, which makes Sentinel's built-in Terraform plugins
 *     available, and
 *   - `tfplan/v2`, `tfconfig/v2` and `tfstate/v2`, all read from the one plan
 *     JSON (`terraform show -json <planfile>`): the plan itself, its
 *     `configuration`, and its `prior_state`.
 *
 * so a policy written `import "tfplan/v2" as tfplan` runs unmodified.
 *
 * Everything below was measured against Sentinel 0.41.0:
 *
 *   - `sentinel apply` exits 1 when ANY policy fails, advisory ones included, so
 *     the exit code cannot gate a policy set. `-json` reports each policy's
 *     `enforcement_level` and `result`, and a top-level `result` that is false
 *     only when a soft- or hard-mandatory policy failed.
 *   - Relative `source` paths in `sentinel.hcl` resolve against the working
 *     directory, not the config file, so the run's directory is the policy set.
 *   - A config with no `policy` block exits 0 with `result: true`.
 *   - A second import block for the same name is a fatal configuration error.
 *   - `tfrun` is not a built-in plugin; a policy that imports it cannot run here.
 *     Declaring a module that imports it is harmless while no policy imports
 *     that module.
 *   - Sentinel writes a cache, `.sentinel/`, into the working directory, and
 *     trusts the module paths a cache already there records; see
 *     sentinel-cache.ts.
 */

const SET_CONFIG = 'sentinel.hcl';
const ENFORCEMENT_LEVELS: ReadonlySet<string> = new Set(['advisory', 'soft-mandatory', 'hard-mandatory']);

/** The Terraform imports HCP Terraform provides, and the config key each plugin reads the plan JSON from. */
const TERRAFORM_IMPORTS: ReadonlyArray<readonly [string, string]> = [
    ['tfplan/v2', 'plan_path'],
    ['tfconfig/v2', 'path'],
    ['tfstate/v2', 'path'],
];

interface SentinelPolicyOutcome {
    policy?: { name?: unknown; enforcement_level?: unknown };
    result?: unknown;
    error?: unknown;
}

interface SentinelApplyOutput {
    result?: unknown;
    error?: unknown;
    policies?: SentinelPolicyOutcome[] | null;
}

/**
 * Refuses a policy set whose `sentinel.hcl` supplies a Terraform import itself.
 *
 * HCP Terraform policy sets never do -- the platform supplies them -- so one that
 * does was written for local testing, against a plan file of its own. Appending
 * this run's import beside it is a fatal duplicate; honouring it instead would
 * evaluate that other plan and report the result as this run's.
 */
export function assertNoTerraformImportOverride(setConfig: string): void {
    const match = /^[ \t]*(?:import[ \t]+"(?:plugin|static|module)"|mock)[ \t]+"(tfplan\/v2|tfconfig\/v2|tfstate\/v2)"/m.exec(setConfig);
    if (match) {
        throw new Error(
            `The policy set's ${SET_CONFIG} configures the '${match[1]}' import itself. With hcpPolicySet the task supplies ` +
            `tfplan/v2, tfconfig/v2 and tfstate/v2 from this run's plan, as HCP Terraform does; remove that block from ` +
            `${SET_CONFIG} (keep it in a test configuration instead).`,
        );
    }
}

/** The blocks HCP Terraform supplies from the run, as HCL to append to the set's own configuration. */
export function terraformImportBlocks(planJsonPath: string): string {
    const lines: string[] = ['', 'sentinel {', '  features = {', '    terraform = true', '  }', '}'];
    for (const [name, key] of TERRAFORM_IMPORTS) {
        lines.push('', `import "plugin" "${name}" {`, '  config = {', `    ${key} = "${hcl(planJsonPath)}"`, '  }', '}');
    }
    return `${lines.join('\n')}\n`;
}

export interface SentinelSetOutcome {
    passed: boolean;
    violations: string[];
    cases: PolicyCase[];
    /** Failed policies that stop the run, after any soft-mandatory override. */
    blocking: string[];
    /** Failed policies that do not. */
    nonBlocking: string[];
}

/**
 * Turns `sentinel apply -json` output into the gate decision, applying each
 * policy's own enforcement level the way HCP Terraform does: an advisory failure
 * never stops the run, a soft-mandatory one stops it unless overridden, a
 * hard-mandatory one always stops it.
 *
 * Fails closed on anything it cannot account for: output that is not the JSON
 * report, a report with no policies, a level it does not know, or its own verdict
 * disagreeing with the CLI's.
 */
export function evaluateSentinelSetOutput(stdout: string, exitCode: number, overrideSoftMandatory: boolean): SentinelSetOutcome {
    let report: SentinelApplyOutput;
    try {
        report = JSON.parse(stdout) as SentinelApplyOutput;
    } catch {
        throw new Error(`Sentinel did not produce its JSON report (exit code ${exitCode}). Output:\n${stdout.slice(0, 2000)}`);
    }
    const policies = Array.isArray(report?.policies) ? report.policies : [];
    if (policies.length === 0) {
        const detail = typeof report?.error === 'string' && report.error ? ` Sentinel reported: ${report.error}` : '';
        throw new Error(
            `Sentinel evaluated no policies (exit code ${exitCode}); refusing to treat that as a pass.${detail} ` +
            `Check that the policy set's ${SET_CONFIG} declares its policies and is valid.`,
        );
    }

    const cases: PolicyCase[] = [];
    const blocking: string[] = [];
    const nonBlocking: string[] = [];
    let mandatoryFailed = false;
    for (const entry of policies) {
        const rawName = typeof entry.policy?.name === 'string' ? entry.policy.name : '';
        const level = typeof entry.policy?.enforcement_level === 'string' ? entry.policy.enforcement_level : '';
        if (!rawName || !ENFORCEMENT_LEVELS.has(level)) {
            throw new Error(`Sentinel reported a policy this task cannot read (name '${rawName}', enforcement level '${level}'); refusing to guess its outcome.`);
        }
        const name = rawName.replace(/\.sentinel$/, '');
        if (entry.result === true) {
            cases.push({ name, passed: true, enforcementLevel: level });
            continue;
        }
        // Sentinel's own explanation of an undefined result or runtime error; its
        // first line names the problem without quoting plan values.
        const reason = typeof entry.error === 'string' && entry.error ? ` ${entry.error.split('\n')[0]}` : '';
        const message = `[${level}] Policy failed: ${name}.${reason}`;
        cases.push({ name, passed: false, enforcementLevel: level, message });
        if (level !== 'advisory') mandatoryFailed = true;
        const stops = level === 'hard-mandatory' || (level === 'soft-mandatory' && !overrideSoftMandatory);
        (stops ? blocking : nonBlocking).push(message);
    }

    // Two independent readings of one run must agree: Sentinel's overall result
    // is false exactly when a mandatory policy failed, and it exits non-zero
    // exactly when any policy failed.
    const anyFailed = blocking.length + nonBlocking.length > 0;
    if ((report.result !== true) !== mandatoryFailed || (exitCode !== 0) !== anyFailed) {
        throw new Error(
            `Sentinel's report is inconsistent (exit code ${exitCode}, overall result ${JSON.stringify(report.result)}, ` +
            `${blocking.length + nonBlocking.length} failed policy/policies); refusing to treat this as a policy pass.`,
        );
    }

    return { passed: blocking.length === 0, violations: [...blocking, ...nonBlocking], cases, blocking, nonBlocking };
}

export async function runSentinelPolicySet(
    sentinelPath: string,
    policyDir: string,
    inputFile: string,
    tempFiles: string[],
): Promise<PolicyResult> {
    const setConfigPath = path.join(policyDir, SET_CONFIG);
    // Read, then interpret a missing file: an existence check before the read
    // would let the file change between the two.
    let setConfig: string;
    try {
        setConfig = fs.readFileSync(setConfigPath, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        throw new Error(
            `hcpPolicySet is enabled but ${setConfigPath} does not exist. The policy source must be the root of an ` +
            `HCP Terraform Sentinel policy set, which holds ${SET_CONFIG} (use policyRepoSubdir if the set is in a subdirectory).`,
        );
    }
    assertNoTerraformImportOverride(setConfig);

    // The task writes nothing into the policy set: the combined configuration
    // goes to the agent's private temp directory, which the agent purges at job
    // end. Sentinel itself writes its .sentinel cache there; withFreshSentinelCache
    // removes it before and after the run.
    const configDir = path.join(tasks.getVariable('Agent.TempDirectory') || os.tmpdir(), `sentinel-config-${uuidV4()}`);
    tempFiles.push(configDir);
    fs.mkdirSync(configDir, { recursive: true });
    const combinedConfigPath = path.join(configDir, SET_CONFIG);
    // A policy set's configuration can carry parameter values; keep the copy owner-only.
    writeSecretFile(combinedConfigPath, `${setConfig}\n${terraformImportBlocks(path.resolve(inputFile))}`);

    const tool = tasks.tool(sentinelPath);
    tool.arg('apply');
    tool.arg('-json');
    tool.arg(['-config', combinedConfigPath]);

    let stdout = '';
    let stderr = '';
    const capture = attachBoundedCapture(tool, (stream, text) => {
        if (stream === 'stdout') stdout += text; else stderr += text;
    });
    // silent: the JSON report carries the full trace, plan values included. The
    // per-policy summary below is what belongs in the log; the report itself is
    // kept, owner-only, as resultsFilePath.
    const code = await withFreshSentinelCache(policyDir, () => execWithTimeout(
        tool,
        <IExecOptions>{ cwd: policyDir, ignoreReturnCode: true, silent: true },
        tasks.loc('PolicyEngineTimedOut', 'sentinel apply', TOOL_EXEC_TIMEOUT_MS),
    ));
    capture.assertWithinCap();

    let outcome: SentinelSetOutcome;
    try {
        outcome = evaluateSentinelSetOutput(stdout, code, tasks.getBoolInput('overrideSoftMandatory', false));
    } catch (err) {
        const detail = stderr.trim() ? `\n${stderr.trim().slice(0, 2000)}` : '';
        throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
    }

    for (const c of outcome.cases) {
        console.log(`${c.passed ? 'PASS' : 'FAIL'} - ${c.name} [${c.enforcementLevel}]`);
    }
    for (const v of outcome.blocking) tasks.error(v);
    for (const v of outcome.nonBlocking) tasks.warning(v);

    return { passed: outcome.passed, violations: outcome.violations, cases: outcome.cases, rawOutput: stdout };
}
