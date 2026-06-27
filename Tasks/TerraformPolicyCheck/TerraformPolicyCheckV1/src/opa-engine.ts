import tasks = require('azure-pipelines-task-lib/task');
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { PolicyResult, PolicyCase } from './types';

/**
 * Evaluates OPA policies against Terraform plan/state JSON using `opa exec`.
 *
 * Runs `opa exec --decision <decisionPath> --bundle <policyDir> <inputFile>`,
 * parses the JSON result, and gates per `failMode`:
 *   - nonEmpty (default): fail when the decision is a non-empty set/array
 *     (the standard `deny` convention where each element is a violation message).
 *   - defined: fail when the decision is defined and truthy.
 */
export async function runOpa(opaPath: string, policyDir: string, inputFile: string): Promise<PolicyResult> {
    const decisionPath = tasks.getInput('decisionPath') || 'terraform/deny';
    const failMode = tasks.getInput('failMode') || 'nonEmpty';

    const tool = tasks.tool(opaPath);
    tool.arg('exec');
    tool.arg(['--decision', decisionPath]);
    tool.arg(['--bundle', policyDir]);
    tool.arg(inputFile);

    let stdout = '';
    let stderr = '';
    tool.on('stdout', (data: string | Buffer) => { stdout += data.toString(); });
    tool.on('stderr', (data: string | Buffer) => { stderr += data.toString(); });

    // opa exec returns 0 even when the decision contains violations; we gate on the
    // parsed result, not the exit code.
    const code = await tool.execAsync(<IExecOptions>{ ignoreReturnCode: true });

    // A non-zero exit is a real failure (bad bundle, malformed input, opa crash),
    // not a policy violation — surface stderr instead of failing later on empty JSON.
    if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || '(no output)';
        throw new Error(`'opa exec' failed (exit code ${code}): ${detail.slice(0, 500)}`);
    }

    let parsed: { result?: Array<{ path?: string; result?: unknown; error?: unknown }> };
    try {
        parsed = JSON.parse(stdout);
    } catch (err) {
        throw new Error(`Failed to parse 'opa exec' output as JSON (exit code ${code}): ${err instanceof Error ? err.message : err}. Output: ${stdout.slice(0, 500)}`);
    }

    const entry = parsed.result && parsed.result[0];
    if (entry && entry.error) {
        throw new Error(`OPA evaluation error for ${entry.path}: ${JSON.stringify(entry.error)}`);
    }

    const decision = entry ? entry.result : undefined;
    const violations = extractViolations(decision, failMode);
    const passed = violations.length === 0;

    const cases: PolicyCase[] = passed
        ? [{ name: decisionPath, passed: true }]
        : violations.map((v, i) => ({ name: `${decisionPath}[${i}]`, passed: false, message: v }));

    for (const v of violations) {
        tasks.error(v);
    }

    return { passed, violations, cases, rawOutput: stdout };
}

function extractViolations(decision: unknown, failMode: string): string[] {
    if (failMode === 'defined') {
        const isFailing = decision !== undefined && decision !== null && decision !== false;
        if (!isFailing) return [];
        return [typeof decision === 'object' ? JSON.stringify(decision) : `Policy decision is ${String(decision)}`];
    }

    // nonEmpty (default): the decision is expected to be a collection of violations.
    if (Array.isArray(decision)) {
        return decision.map(d => typeof d === 'string' ? d : JSON.stringify(d));
    }
    if (decision && typeof decision === 'object') {
        // Object form: keys mapped to truthy values are violations.
        return Object.entries(decision as Record<string, unknown>)
            .filter(([, v]) => v === true || (typeof v === 'string' && v.length > 0))
            .map(([k, v]) => typeof v === 'string' ? v : k);
    }
    return [];
}
