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
        level = validateEnforcementLevel(tasks.getInput('defaultEnforcementLevel') || 'soft-mandatory');
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

    // Sentinel's documented exit codes are 0 (pass), 1 (policy failed), 2 (undefined
    // result), 3 (runtime error, handled above), and 9 (other error, handled above).
    // Any other code — e.g. 126/127 (not executable / not found), 137/139
    // (SIGKILL/SIGSEGV), an OOM-killed process, or a future Sentinel exit code this
    // task does not yet recognize — must NOT be silently treated as a pass: without
    // this check it falls through to `policyFailed = false` below and the policy
    // gate reports `passed: true` on an abnormal process outcome. Fail closed
    // instead, mirroring opa-engine's exhaustive `code !== 0` check.
    if (code !== 0 && code !== 1 && code !== 2) {
        throw new Error(`Sentinel exited with an unrecognized code (${code}); refusing to treat this as a policy pass. Output:\n${stdout.slice(0, 2000)}`);
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

const SENTINEL_ENFORCEMENT_LEVELS = new Set(['advisory', 'soft-mandatory', 'hard-mandatory']);

/**
 * The enforcement level is embedded verbatim into the generated sentinel.hcl as a
 * quoted HCL string — `enforcement_level = "<level>"`. ADO does not enforce
 * picklist values at runtime, and unlike the source paths this field is not routed
 * through `hcl()`. Constrain it to the exact set of levels Sentinel itself accepts
 * in that position (the only thing that belongs there anyway).
 */
export function validateEnforcementLevel(level: string): string {
    if (!SENTINEL_ENFORCEMENT_LEVELS.has(level)) {
        throw new Error(
            `Invalid defaultEnforcementLevel '${level}': must be one of ` +
            `advisory, soft-mandatory, hard-mandatory.`
        );
    }
    return level;
}

/** Generates a sentinel.hcl in a temp dir; returns that dir. */
export function generateConfig(policyDir: string, inputFile: string, level: string, tempFiles: string[]): string {
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
        // The policy name (derived from the .sentinel file's basename) is a plain
        // quoted HCL string label here, not an identifier reference used elsewhere
        // in policy code like the import name above -- legitimate filenames commonly
        // use dashes (e.g. require-tags.sentinel), so it must not be restricted to
        // identifier syntax. `hcl()` escaping (including CR/LF -> literal `\n`,
        // #648) keeps the value inside the string on a single line, so a policy
        // filename containing an embedded newline (reachable when
        // policySource=gitUrl points at a shared/third-party policy repo whose
        // filenames aren't fully trusted) renders as a literal `\n` in the label
        // instead of producing a raw multi-line string that would otherwise hard-fail
        // sentinel.hcl's parse ("Invalid multi-line string").
        const name = path.basename(policyFile, '.sentinel');
        lines.push(`policy "${hcl(name)}" {`);
        lines.push(`  source = "${hcl(policyFile)}"`);
        lines.push(`  enforcement_level = "${level}"`);
        lines.push(`}`);
        lines.push('');
    }

    // Agent.TempDirectory is auto-purged by the ADO agent at job end, which
    // backstops cleanup even if the process is killed before index.ts's
    // finally/cleanup() can run — bare os.tmpdir() has no such guarantee
    // (matches policy-source.ts's cloneDir convention; issues #503/#505).
    const configDir = path.join(tasks.getVariable('Agent.TempDirectory') || os.tmpdir(), `sentinel-config-${uuidV4()}`);
    tempFiles.push(configDir);
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'sentinel.hcl');
    fs.writeFileSync(configPath, lines.join('\n'), 'utf-8');
    return configDir;
}

/**
 * Escapes a value (path or policy name) for embedding in an HCL double-quoted
 * string. Backslash and double-quote are escaped so the value cannot break out
 * of the quoted string; `${` and `%{` are escaped to their literal HCL forms
 * (`$${` / `%%{`) so a policy filename carrying template-interpolation syntax
 * (reachable when policySource=gitUrl points at a third-party policy repo) is
 * reproduced literally instead of being evaluated by the HCL parser; CR/LF are
 * escaped to a literal `\n` so a policy filename containing an embedded
 * newline (valid on Linux/macOS) cannot produce a raw multi-line string in the
 * generated sentinel.hcl — matching TerraformProviderMirror's escapeHclString.
 * Without this, HCL's quoted-string grammar hard-fails to parse such a value
 * ("Invalid multi-line string"), which is a fail-closed error rather than a
 * bypass, but escaping keeps this generator consistent with its sibling and
 * turns the failure into a normal, literal-string result instead of an opaque
 * Sentinel parse error (#648). The `$`/`%` escapes use replacer functions
 * because a plain `'$${'` replacement string would itself be mangled by JS's
 * `$$` substitution rules; they only touch `$`/`%`/`{` and never a backslash
 * or newline, so they cannot interfere with the backslash or CR/LF passes.
 */
export function hcl(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$\{/g, () => '$${')
        .replace(/%\{/g, () => '%%{')
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\n');
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
