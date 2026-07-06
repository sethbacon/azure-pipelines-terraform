import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { PolicyResult, PolicyCase } from './types';

/**
 * Evaluates Sentinel policies against Terraform plan JSON.
 *
 * By default a `sentinel.hcl` config is generated that wires the plan JSON in as
 * a static import and lists every `*.sentinel` policy at the chosen enforcement
 * level. `sentinel apply` then runs all policies. Exit codes (0 pass, 1 fail,
 * 2 undefined, 3 runtime error, 9 other) drive the outcome; the standalone CLI
 * does not gate on enforcement_level, so this task applies the level itself:
 *   - advisory       → failures warn but do not fail the task
 *   - soft-mandatory → failures fail the task unless overrideSoftMandatory
 *   - hard-mandatory → failures always fail the task
 *
 * If `sentinelConfigPath` is supplied, that config is used as-is and the task
 * gates purely on the exit code (enforcement levels are whatever the config sets).
 */
export async function runSentinel(
    sentinelPath: string,
    policyDir: string,
    inputFile: string,
    tempFiles: string[]
): Promise<PolicyResult> {
    const traceOutput = tasks.getBoolInput('traceOutput', false);
    const byoConfig = tasks.getInput('sentinelConfigPath');

    let workingDir: string;
    let level: string | undefined;

    if (byoConfig) {
        workingDir = path.dirname(path.resolve(byoConfig));
    } else {
        level = tasks.getInput('defaultEnforcementLevel') || 'soft-mandatory';
        workingDir = generateConfig(policyDir, path.resolve(inputFile), level, tempFiles);
    }

    const tool = tasks.tool(sentinelPath);
    tool.arg('apply');
    if (traceOutput) tool.arg('-trace');

    let stdout = '';
    tool.on('stdout', (data: string | Buffer) => { stdout += data.toString(); });
    tool.on('stderr', (data: string | Buffer) => { stdout += data.toString(); });

    const code = await tool.execAsync(<IExecOptions>{ cwd: workingDir, ignoreReturnCode: true });

    if (code === 3 || code === 9) {
        throw new Error(`Sentinel returned a non-policy error (exit code ${code}). Output:\n${stdout.slice(0, 2000)}`);
    }

    const policyFailed = code === 1 || code === 2;
    const cases = parseCases(stdout, level);

    const override = tasks.getBoolInput('overrideSoftMandatory', false);
    const { passed, violations } = applyEnforcement(policyFailed, level, override, cases, stdout, byoConfig !== undefined);

    if (!passed) {
        for (const v of violations) tasks.error(v);
    } else if (policyFailed) {
        // Failures that were downgraded (advisory, or overridden soft-mandatory).
        for (const v of violations) tasks.warning(v);
    }

    return { passed, violations, cases, rawOutput: stdout };
}

function applyEnforcement(
    policyFailed: boolean,
    level: string | undefined,
    override: boolean,
    cases: PolicyCase[],
    stdout: string,
    isByoConfig: boolean
): { passed: boolean; violations: string[] } {
    const failedNames = cases.filter(c => !c.passed).map(c => c.name);
    const violations = failedNames.length > 0
        ? failedNames.map(n => `Policy failed: ${n}`)
        : (policyFailed ? [`Sentinel policy evaluation failed.\n${stdout.slice(0, 2000)}`.trim()] : []);

    if (!policyFailed) return { passed: true, violations: [] };

    // BYO config: enforcement is baked into the user's config; gate on exit code.
    if (isByoConfig) return { passed: false, violations };

    switch (level) {
        case 'advisory':
            return { passed: true, violations };
        case 'hard-mandatory':
            return { passed: false, violations };
        case 'soft-mandatory':
        default:
            return override ? { passed: true, violations } : { passed: false, violations };
    }
}

const SENTINEL_IMPORT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The Sentinel import name is embedded verbatim into the generated sentinel.hcl as
 * an HCL identifier — `import "static" "<name>" { ... }`. Unlike the source paths,
 * which `hcl()` escapes, the identifier is not escapable; an unconstrained value
 * could close the import block and inject arbitrary HCL. Constrain it to a valid
 * identifier (the only thing Sentinel accepts in that position anyway).
 */
export function validateSentinelImportName(name: string): string {
    if (!SENTINEL_IMPORT_NAME_RE.test(name)) {
        throw new Error(
            `Invalid sentinelImportName '${name}': must be a valid identifier ` +
            `(letters, digits, and underscores; not starting with a digit).`
        );
    }
    return name;
}

/** Generates a sentinel.hcl in a temp dir; returns that dir. */
function generateConfig(policyDir: string, inputFile: string, level: string, tempFiles: string[]): string {
    const importName = validateSentinelImportName(tasks.getInput('sentinelImportName') || 'tfplan');
    const policies = findSentinelPolicies(policyDir);
    if (policies.length === 0) {
        throw new Error(`No .sentinel policy files found in ${policyDir}.`);
    }

    const lines: string[] = [];
    lines.push(`import "static" "${importName}" {`);
    lines.push(`  source = "${hcl(inputFile)}"`);
    lines.push(`  format = "json"`);
    lines.push(`}`);
    lines.push('');
    for (const policyFile of policies) {
        const name = path.basename(policyFile, '.sentinel');
        lines.push(`policy "${name}" {`);
        lines.push(`  source = "${hcl(policyFile)}"`);
        lines.push(`  enforcement_level = "${level}"`);
        lines.push(`}`);
        lines.push('');
    }

    const configDir = path.join(os.tmpdir(), `sentinel-config-${uuidV4()}`);
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'sentinel.hcl');
    fs.writeFileSync(configPath, lines.join('\n'), 'utf-8');
    tempFiles.push(configDir);
    return configDir;
}

/** Escapes a path for embedding in an HCL double-quoted string. */
function hcl(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findSentinelPolicies(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findSentinelPolicies(full));
        } else if (entry.isFile() && entry.name.endsWith('.sentinel')) {
            results.push(full);
        }
    }
    return results.sort();
}

/** Best-effort parse of `sentinel apply` per-policy PASS/FAIL lines for JUnit. */
function parseCases(stdout: string, level: string | undefined): PolicyCase[] {
    const cases: PolicyCase[] = [];
    const re = /^(PASS|FAIL)\s*-\s*(.+?)\s*$/gim;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stdout)) !== null) {
        cases.push({
            name: match[2].trim(),
            passed: match[1].toUpperCase() === 'PASS',
            enforcementLevel: level,
        });
    }
    return cases;
}
