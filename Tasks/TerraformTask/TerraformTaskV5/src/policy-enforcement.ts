import fs = require('fs');
import tasks = require('azure-pipelines-task-lib/task');
import { readUrlInput } from '@4cloudguru/pipeline-task-ado';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { splitCommandOptions, splitNonEmptyLines } from './argument-builder';
import { detectBackendCloud } from './backend-detection';
import { PolicyEvent, parsePolicyEvent } from './policy-results';

/**
 * Terraform Policy (`-policies`, generally available from Terraform 1.17).
 *
 * Terraform evaluates `.policy.hcl` policies itself, through a separate
 * `tfpolicy-plugin` binary it launches, during init, plan, apply and destroy.
 * Two properties of that design are why this module exists rather than a bare
 * pass-through flag:
 *
 *  1. The plugin only runs for an HCP Terraform / Terraform Enterprise backend.
 *     It asks Terraform for the organization's policy entitlement, and no other
 *     backend can supply one ("entitlement check failed: client did not supply
 *     entitlement information", tfpolicy-plugin 0.5.0).
 *
 *  2. plan, apply and destroy FAIL OPEN. When the engine cannot start -- plugin
 *     missing, not entitled, a policy file that does not load -- Terraform prints
 *     an error diagnostic and carries on without policies, exiting 0 (or 2 from
 *     `plan -detailed-exitcode`). Verified against Terraform 1.17.2: an apply
 *     created the very resource a mandatory policy forbade and reported success.
 *     Only init stops.
 *
 * So the task refuses up front what can never work, and afterwards refuses to
 * report success for a run in which Terraform printed an error yet exited
 * cleanly -- a combination Terraform otherwise never produces, and the only
 * signal that the policies a pipeline asked for were not enforced.
 */

/**
 * Commands that take the `policyPaths` input: the ones whose Terraform
 * counterpart accepts `-policies`. (`custom` is guarded too, but only for a
 * `-policies` the pipeline wrote into its own command text.)
 */
export const POLICY_COMMANDS: ReadonlySet<string> = new Set(['init', 'plan', 'apply', 'destroy']);

/** Commands that take `publishPolicyResults`: the ones this task can run with `-json`. */
export const POLICY_RESULT_COMMANDS: ReadonlySet<string> = new Set(['plan', 'apply', 'destroy']);

/** Terraform reads the policy engine's path from this variable, falling back to PATH. */
export const POLICY_PLUGIN_ENV = 'TF_POLICY_PLUGIN';
const POLICY_PLUGIN_BINARY = 'tfpolicy-plugin';

/** A partial line longer than this is not a diagnostic header; stop buffering it. */
const MAX_PENDING_LINE_CHARS = 64 * 1024;
const MAX_REPORTED_LINE_CHARS = 300;
/** Bound on collected policy events, so a huge configuration cannot grow the list without limit. */
export const MAX_POLICY_EVENTS = 20_000;

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/**
 * Returns the values of every `-policies` flag in `commandOptions`, read with
 * the same tokenizer ToolRunner uses. Terraform's flag parser accepts one or two
 * leading dashes and either `=value` or a separate value token.
 */
export function policyPathsInCommandOptions(commandOptions: string | undefined): string[] {
    if (!commandOptions) return [];
    const tokens = splitCommandOptions(commandOptions);
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const eq = tokens[i].match(/^--?policies=(.*)$/);
        if (eq) {
            paths.push(eq[1]);
        } else if (/^--?policies$/.test(tokens[i])) {
            // A dangling flag still counts as a request for policies; Terraform
            // rejects it, and the guards below must not be skipped meanwhile.
            paths.push(tokens[i + 1] ?? '');
            i++;
        }
    }
    return paths;
}

/**
 * Whether one line of Terraform's output is an error diagnostic.
 *
 * Human output puts diagnostics on stderr as `Error: <summary>`, inside a
 * coloured box unless `-no-color` is set. With `-json` they are stdout events
 * carrying `"@level":"error"`. Each form is matched only on its own stream:
 * stdout in human mode is the plan itself, where a multi-line attribute value
 * can legitimately contain a line reading `Error: ...`.
 */
export function isErrorDiagnosticLine(stream: 'stdout' | 'stderr', line: string): boolean {
    const text = line.replace(ANSI_SGR, '');
    return stream === 'stderr'
        ? /^[\s│|]*Error: /.test(text)
        : /^\{"@level":"error"/.test(text);
}

/** The readable part of a diagnostic line: a `-json` event's `@message`, else the line without colour or box. */
function diagnosticSummary(line: string): string {
    const text = line.replace(ANSI_SGR, '').trim();
    try {
        const message = (JSON.parse(text) as { '@message'?: unknown })['@message'];
        if (typeof message === 'string') return message;
    } catch { /* human output */ }
    return text.replace(/^[\s│|]+/, '');
}

/** The policy state of one command run: the argv to add, and the fail-open check. */
export class PolicyEnforcement {
    /** No policies requested: adds nothing, watches nothing, never fails. */
    static readonly inactive = new PolicyEnforcement([], false);

    private errorLine: string | undefined;
    private readonly pending = { stdout: '', stderr: '' };
    private readonly collected: PolicyEvent[] = [];
    private dropped = 0;

    /** The policy events Terraform reported, when the run used `-json`; empty otherwise. */
    get events(): readonly PolicyEvent[] {
        return this.collected;
    }

    /** How many policy events arrived after {@link MAX_POLICY_EVENTS} was reached. */
    get droppedEvents(): number {
        return this.dropped;
    }

    constructor(
        /** `-policies=<path>` tokens for the `policyPaths` input, one per path. */
        readonly tokens: readonly string[],
        /** True when policies were requested, by input or through `commandOptions`. */
        readonly active: boolean,
    ) { }

    /** Listens to the tool's output for an error diagnostic. Call before it runs. */
    watch(tool: ToolRunner): void {
        if (!this.active) return;
        for (const stream of ['stdout', 'stderr'] as const) {
            tool.on(stream, (data: string | Buffer) => this.consume(stream, data.toString()));
        }
    }

    private consume(stream: 'stdout' | 'stderr', chunk: string): void {
        let buffered = this.pending[stream] + chunk;
        let nl: number;
        while ((nl = buffered.indexOf('\n')) !== -1) {
            this.inspect(stream, buffered.slice(0, nl));
            buffered = buffered.slice(nl + 1);
        }
        this.pending[stream] = buffered.length > MAX_PENDING_LINE_CHARS ? '' : buffered;
    }

    private inspect(stream: 'stdout' | 'stderr', line: string): void {
        const event = stream === 'stdout' ? parsePolicyEvent(line) : undefined;
        if (event) {
            if (this.collected.length < MAX_POLICY_EVENTS) this.collected.push(event); else this.dropped++;
        }
        if (this.errorLine === undefined && isErrorDiagnosticLine(stream, line)) {
            this.errorLine = diagnosticSummary(line).slice(0, MAX_REPORTED_LINE_CHARS);
        }
    }

    /** Reads the final line of each stream, which may have arrived without a trailing newline. */
    flush(): void {
        for (const stream of ['stdout', 'stderr'] as const) {
            const line = this.pending[stream];
            this.pending[stream] = '';
            if (line) this.inspect(stream, line);
        }
    }

    /**
     * Call once the command has returned successfully. Throws when Terraform
     * printed an error diagnostic on a run that asked for policies: the run
     * exited cleanly, so the error was one Terraform chose to continue past.
     */
    verify(command: string): void {
        if (!this.active) return;
        this.flush();
        if (this.errorLine === undefined) return;
        throw new Error(
            `Terraform ${command} reported an error but still exited successfully while policies were requested: ` +
            `'${this.errorLine}'. Terraform continues without policy enforcement when its policy engine cannot start ` +
            `or load the policies, so this run was NOT checked against them` +
            (command === 'plan' ? '; do not apply a plan saved by this step.' : ', and any changes it made stand.') +
            ` See docs/yaml-examples.md#terraform-policy.`,
        );
    }
}

/** Whether the policy engine binary Terraform will launch can be found. */
function policyPluginAvailable(): boolean {
    const configured = process.env[POLICY_PLUGIN_ENV];
    if (configured) {
        return fs.existsSync(configured);
    }
    return !!tasks.which(POLICY_PLUGIN_BINARY, false);
}

/**
 * Reads the `policyPaths` input and any `-policies` in `commandOptions`, and
 * returns the enforcement for this run. Throws, before Terraform is started,
 * when policies are requested somewhere they cannot be enforced.
 *
 * Deliberately NOT checked here, because Terraform already stops on each with
 * its own clear error: a Terraform older than 1.17, and a policy path that does
 * not exist.
 */
export function preparePolicyEnforcement(
    command: string,
    commandOptions: string | undefined,
    workingDirectory: string,
    binaryName: string,
): PolicyEnforcement {
    // Read through the package's silent reader, like every other path-shaped input:
    // task-lib's getInput debug-logs the raw value before anything can register a
    // credential embedded in it.
    const inputPaths = POLICY_COMMANDS.has(command) ? splitNonEmptyLines(readUrlInput('policyPaths', false)) : [];
    if (inputPaths.length === 0 && policyPathsInCommandOptions(commandOptions).length === 0) {
        return PolicyEnforcement.inactive;
    }

    if (binaryName !== 'terraform') {
        throw new Error(
            `Terraform Policy (-policies) is a Terraform feature and is not available in '${binaryName}'. ` +
            `Remove 'policyPaths', or use the PipelineTerraformPolicyCheck task to evaluate OPA or Sentinel policies.`,
        );
    }

    // init is choosing the backend; every later command reads the one init recorded.
    const backendIsHcp = command === 'init'
        ? tasks.getInput('backendType', false) === 'hcp'
        : detectBackendCloud(workingDirectory) === 'hcp';
    if (!backendIsHcp) {
        throw new Error(
            `Terraform Policy (-policies) requires an HCP Terraform or Terraform Enterprise backend` +
            (command === 'init' ? ` (backendType: hcp)` : `, and '${workingDirectory || '.'}' was not initialized with one`) +
            `. With any other backend Terraform's policy engine refuses to start and Terraform runs '${command}' ` +
            `without enforcing the policies. Use the PipelineTerraformPolicyCheck task to evaluate OPA or Sentinel ` +
            `policies against other backends.`,
        );
    }

    if (!policyPluginAvailable()) {
        throw new Error(
            `Terraform Policy (-policies) needs the '${POLICY_PLUGIN_BINARY}' policy engine, which was not found ` +
            (process.env[POLICY_PLUGIN_ENV] ? `at ${POLICY_PLUGIN_ENV}=${process.env[POLICY_PLUGIN_ENV]}` : `on the PATH`) +
            `. Install it earlier in the same job with PipelinePolicyAgentInstaller (policyAgent: tfpolicy-plugin), ` +
            `or set ${POLICY_PLUGIN_ENV} to its path.`,
        );
    }

    return new PolicyEnforcement(inputPaths.map(p => `-policies=${p}`), true);
}
