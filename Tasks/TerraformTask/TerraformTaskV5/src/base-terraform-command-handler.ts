import { TerraformToolHandler, ITerraformToolHandler, getBinaryName, resolveToolPath } from './terraform';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformBaseCommandInitializer, TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { getSecureVarFileArgs, SecureFileLoader } from './secure-file-loader';
import { replaceSecretFile, scrubFile, writeSecretFile } from './secure-temp';
import { buildPlanDigest, DigestMeta } from './results/plan-digest';
import { buildApplyDigest, ApplyDigestOptions } from './results/apply-digest';
import { buildStateDigest } from './results/state-digest';
import { Digest } from './results/digest-schema';
import { serializeDigest, maskHasSensitiveLeaf } from './results/redact';
import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';
import fs = require('fs');
import os = require('os');

/** Validates Terraform resource addresses (e.g. `aws_instance.foo`, `module.bar["key"]`). */
export const RESOURCE_ADDRESS_RE = /^[a-zA-Z_][\w\-]*(\[[^\]]+\])?(\.[a-zA-Z_][\w\-]*(\[[^\]]+\])?)*$/;

/**
 * Splits a multi-line task input into trimmed, non-empty lines -- the common
 * core of this task's several multi-line-input parsers (var-file paths, target
 * addresses, -var tokens, -backend-config args). Each line is kept whole (never
 * further split) so a value containing spaces -- a path on a Windows agent, or
 * a quoted index key like `module.x["a b"]` -- survives as one token.
 * `skipComments` additionally drops lines starting with `#`, matching the
 * `-var`/`-backend-config` inputs' existing support for comment lines; the
 * var-file/target-address inputs never supported that and keep it disabled so
 * behavior here is unchanged from before this helper existed.
 */
export function splitNonEmptyLines(input: string | undefined, opts: { skipComments?: boolean } = {}): string[] {
    if (!input) return [];
    return input
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !(opts.skipComments && l.startsWith('#')));
}

/**
 * Splits a multi-line `varFile` input into `-var-file=<path>` tokens, one per
 * non-empty line. Each path is kept whole so it can be passed as a single argv
 * entry — paths containing spaces (common on Windows agents) must not be split.
 */
export function parseVarFileTokens(varFile: string | undefined): string[] {
    return splitNonEmptyLines(varFile).map(f => `-var-file=${f}`);
}

/**
 * Splits a multi-line `targetResources` input into validated `-target=<address>`
 * tokens. Addresses may legitimately contain spaces inside quoted index keys
 * (e.g. `module.x["a b"]`), so each is kept as a single argv entry.
 */
export function parseTargetTokens(targetResources: string | undefined): string[] {
    const lines = splitNonEmptyLines(targetResources);
    for (const address of lines) {
        if (!RESOURCE_ADDRESS_RE.test(address)) {
            throw new Error(`Invalid target address '${address}': must be a valid Terraform resource address`);
        }
    }
    return lines.map(a => `-target=${a}`);
}

/**
 * Best-effort heuristic (Phase 5 §5.5) for whether a `show` command's
 * `commandOptions` carries a positional plan-file argument (e.g. `tfplan.out`,
 * or `-no-color tfplan.out`) as opposed to flags only. Terraform's `show`
 * reads a saved plan file when given one, or the CURRENT state when given
 * none -- and this task has no other signal to distinguish the two, since a
 * plan-file path is free text embedded in `commandOptions` alongside any
 * flags, not a separate input. Used ONLY to gate the new `publishStateResults`
 * structured-state-summary path (never the pre-existing show-of-planfile
 * sensitive-output/destroy-change detection, which is unconditional and
 * unaffected by this function): a positional token found here means this run
 * is a planfile show, so the state-summary attachment is skipped even if
 * `publishStateResults` is set (documented in the task's helpMarkDown).
 *
 * Deliberately NOT a full shell parser -- it recognizes double-quoted tokens
 * (`"a plan file.out"`) but not single quotes or backslash escapes, matching
 * ToolRunner's own `.line()` closely enough for this best-effort gate. A
 * value that isn't a flag (doesn't start with `-`) is treated as positional.
 */
export function hasPositionalCommandArg(commandOptions: string | undefined): boolean {
    if (!commandOptions) return false;
    const tokens = commandOptions.match(/"[^"]*"|\S+/g) || [];
    return tokens.some(t => !t.startsWith('-'));
}

/**
 * Returns the plan-file path from a user-supplied `-out=<path>` / `-out <path>`
 * (double-dash `--out` accepted too, as Terraform does) token in
 * `commandOptions`, or undefined if none is present. Uses the SAME best-effort
 * tokenizer as {@link hasPositionalCommandArg} (double-quoted whole tokens are
 * recognized -- and their quotes stripped so the returned path matches what
 * ToolRunner's `.line()` passes to Terraform -- single quotes / backslash
 * escapes / an `-out="quoted value with spaces"` equals-form are not, matching
 * that helper's documented limits).
 *
 * Used ONLY by plan()/destroy()'s publishPlanSummary path (#612): when the user
 * already saves the plan via their own `-out=`, the task must NOT inject a second
 * `-out=` -- Terraform silently honors only the LAST `-out=` on the command line,
 * so the task's tempfile would shadow the user's file and the user's artifact
 * plan would never be written. When a user `-out=` is present the subsequent
 * `terraform show -json` digest is built against the user's own saved plan (which
 * then describes the very plan that gets applied); when absent, the task injects
 * its own tempfile exactly as before.
 */
export function extractOutFlagPath(commandOptions: string | undefined): string | undefined {
    if (!commandOptions) return undefined;
    const tokens = commandOptions.match(/"[^"]*"|\S+/g) || [];
    const stripQuotes = (s: string): string => s.replace(/"/g, '');
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const eq = token.match(/^--?out=(.*)$/);
        if (eq) return stripQuotes(eq[1]);
        if (token === '-out' || token === '--out') {
            const next = tokens[i + 1];
            if (next !== undefined) return stripQuotes(next);
        }
    }
    return undefined;
}

// `warnIfSensitiveOutputs`'s sensitivity detection is the SAME predicate the WP-1
// redaction core applies (design §5.2.7): rather than re-derive it here (the
// detection-vs-redaction drift class, #446), it is defined ONCE in
// `src/results/redact.ts` beside `redactNode` and re-exported here so existing
// importers (Tests/MaskHasSensitiveLeafL0.ts) keep their entry point.
export { maskHasSensitiveLeaf };

/**
 * Reads this task's own version from task.json (Major.Minor.Patch) for the
 * structured digest's `producedBy.taskVersion` field (design §4.1). Falls back
 * to 'unknown' rather than throwing -- a version-read failure must not prevent
 * an already-redacted, already-computed digest from being attached.
 */
export function getTaskVersion(): string {
    try {
        const raw = fs.readFileSync(path.join(__dirname, '..', 'task.json'), 'utf-8');
        const v = JSON.parse(raw).version;
        return `${v.Major}.${v.Minor}.${v.Patch}`;
    } catch {
        return 'unknown';
    }
}

/**
 * The digest's `meta.workingDirectory` must be a relative path only, never an
 * absolute host filesystem path (design §4.1 -- avoids leaking agent directory
 * layout into a build-read-scoped attachment). The `workingDirectory` task
 * input is normally relative, but is not validated as such; an absolute value
 * is simply omitted rather than passed through.
 */
export function relativeWorkingDirectoryForDigest(workingDirectory: string): string | undefined {
    if (!workingDirectory || path.isAbsolute(workingDirectory)) return undefined;
    return workingDirectory;
}

/**
 * Single abstract base carrying every terraform sub-command (init/plan/apply/...)
 * plus the auth/temp-file plumbing shared by all provider handlers. The size is a
 * deliberate cohesion trade-off: the provider subclasses (azure/aws/gcp/oci/hcp/
 * generic) override only handleBackend()/handleProvider() and inherit one identical
 * command-execution path, which is exactly what keeps provider behavior consistent.
 * Known separable concerns, if this is ever decomposed: argv/flag building, the
 * per-command implementations, provider-detection output parsing, plan-result
 * inspection, and temp-file lifecycle. Splitting them is a pure refactor with no
 * behavior change — intentionally deferred, not an oversight.
 */
export abstract class BaseTerraformCommandHandler {
    providerName: string;
    terraformToolHandler: ITerraformToolHandler;
    backendConfig: Map<string, string>;
    protected tempFiles: string[];
    private secureFileId: string | null = null;
    private static readonly OUTPUT_VAR_MAX_LENGTH = 1024;

    abstract handleBackend(terraformToolRunner: ToolRunner): Promise<void>;
    abstract handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void>;

    /**
     * Configures this handler's cloud credentials as environment variables
     * ONLY — never `-backend-config` args, never a tool-runner argument — so a
     * *different* cloud's state backend can authenticate on a state-accessing
     * command (plan/apply/destroy/refresh/import/output/state/workspace/
     * forceunlock). Invoked by ParentCommandHandler exclusively when
     * `backend-detection.ts` finds the initialized backend is a managed cloud
     * backend that differs from the `provider` input — never during `init`
     * (handleBackend already owns backend auth there) and never for the
     * provider's own handler. Implementations that have no cloud identity to
     * inject (OCI's PAR-based http backend, generic/local) are no-ops.
     */
    abstract configureBackendCredentials(): Promise<void>;

    constructor() {
        this.providerName = "";
        this.terraformToolHandler = new TerraformToolHandler(tasks);
        this.backendConfig = new Map<string, string>();
        this.tempFiles = [];
    }

    // --- Helper methods to reduce duplication ---

    /** Authorization schemes accepted for every provider's backend/environment auth-scheme inputs. */
    protected static readonly VALID_AUTH_SCHEMES = ["ServiceConnection", "WorkloadIdentityFederation"] as const;

    /**
     * Validates a provider's `*AuthScheme*` input against {@link VALID_AUTH_SCHEMES}.
     * Shared by the AWS/GCP/OCI handlers (previously copy-pasted verbatim in each) so
     * a future scheme addition/typo can't diverge silently between otherwise-parallel
     * providers.
     */
    protected validateAuthScheme(scheme: string, inputName: string): void {
        if (!(BaseTerraformCommandHandler.VALID_AUTH_SCHEMES as readonly string[]).includes(scheme)) {
            throw new Error(`Unrecognized authorization scheme '${scheme}' for input '${inputName}'. Valid values: ${BaseTerraformCommandHandler.VALID_AUTH_SCHEMES.join(", ")}`);
        }
    }

    protected getWorkingDirectory(): string {
        return tasks.getInput("workingDirectory") || '';
    }

    protected getServiceName(): string {
        return `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
    }

    protected getCommandOptions(): string | undefined {
        return tasks.getInput("commandOptions") || undefined;
    }

    protected createAuthCommand(commandName: string, additionalArgs?: string): TerraformAuthorizationCommandInitializer {
        return new TerraformAuthorizationCommandInitializer(
            commandName,
            this.getWorkingDirectory(),
            tasks.getInput(this.getServiceName(), true)!,
            additionalArgs
        );
    }

    protected createBaseCommand(commandName: string, additionalArgs?: string): TerraformBaseCommandInitializer {
        return new TerraformBaseCommandInitializer(
            commandName,
            this.getWorkingDirectory(),
            additionalArgs
        );
    }

    protected replaceTokens(): string[] {
        const replaceAddress = tasks.getInput("replaceAddress", false);
        if (!replaceAddress) return [];
        if (!RESOURCE_ADDRESS_RE.test(replaceAddress)) {
            throw new Error(`Invalid replace address '${replaceAddress}': must be a valid Terraform resource address`);
        }
        return [`-replace=${replaceAddress}`];
    }

    /** Returns the `-parallelism=N` token, or [] if not set. Validates the value. */
    protected parallelismTokens(): string[] {
        const parallelism = tasks.getInput("parallelism", false);
        if (!parallelism) return [];
        const n = parseInt(parallelism, 10);
        if (isNaN(n) || n < 1) {
            throw new Error(`Invalid parallelism value '${parallelism}': must be a positive integer`);
        }
        return [`-parallelism=${n}`];
    }

    /** Downloads the secure var file (if configured) and returns its `-var-file=<path>` token. */
    protected async secureVarFileTokens(): Promise<string[]> {
        const result = await getSecureVarFileArgs();
        if (!result) return [];
        this.secureFileId = result.secureFileId;
        return [result.varFileArg];
    }

    /**
     * Builds the structured leading flags that precede the base command. Each flag
     * is returned as a single argv token (applied later via {@link applyTokens})
     * so values containing spaces — a var-file path on a Windows agent, or a
     * target/replace address with a quoted index key — are never split.
     *
     * Token order (left to right): secureVarFile, targetResources, varFiles,
     * refreshOnly, replace. Flag order is irrelevant to Terraform; it is fixed
     * here only for predictability and stable test assertions.
     */
    protected async buildLeadingArgs(config: {
        replaceFlag?: boolean;
        refreshOnly?: boolean;
        varFiles?: boolean;
        targetResources?: boolean;
        secureVarFile?: boolean;
    }): Promise<string[]> {
        const tokens: string[] = [];
        if (config.secureVarFile) tokens.push(...await this.secureVarFileTokens());
        if (config.targetResources) tokens.push(...parseTargetTokens(tasks.getInput("targetResources", false)));
        if (config.varFiles) tokens.push(...parseVarFileTokens(tasks.getInput("varFile", false)));
        if (config.refreshOnly && tasks.getBoolInput("refreshOnly", false)) tokens.push('-refresh-only');
        if (config.replaceFlag) tokens.push(...this.replaceTokens());
        return tokens;
    }

    /** Applies tokens to a tool runner as individual argv entries (no re-splitting). */
    protected applyTokens(tool: ToolRunner, tokens: string[]): void {
        for (const token of tokens) {
            tool.arg(token);
        }
    }

    protected appendTerraformVariables(terraformTool: ToolRunner): void {
        const variables = tasks.getInput("terraformVariables", false);
        if (!variables) return;

        for (const trimmed of splitNonEmptyLines(variables, { skipComments: true })) {
            terraformTool.arg('-var');
            terraformTool.arg(trimmed);
        }
    }

    // --- Core infrastructure ---

    protected async execWithStdoutCapture(terraformTool: ToolRunner, options: IExecOptions): Promise<{ code: number; stdout: string; stderr: string }> {
        let stdout = '';
        let stderr = '';
        terraformTool.on('stdout', (data: string | Buffer) => {
            stdout += data.toString();
        });
        // #613: capture stderr too. When a caller runs with `silent: true` (the
        // structured apply path) the ToolRunner suppresses its own echo of the
        // child's output, and Terraform writes CLI usage errors / provider
        // crashes to STDERR rather than the stdout stream the caller consumes --
        // so without capturing stderr those failures are completely invisible
        // (the production incident behind #613). Callers that don't need it
        // simply ignore the field.
        terraformTool.on('stderr', (data: string | Buffer) => {
            stderr += data.toString();
        });

        const code = await terraformTool.execAsync(options);

        return { code, stdout, stderr };
    }

    public cleanupTempFiles(): void {
        for (const filePath of this.tempFiles) {
            try {
                if (fs.existsSync(filePath)) {
                    // Scrub the content (overwrite with zeros) before unlinking, uniformly
                    // for every tracked secret temp file -- OIDC/UPST/token files, GCP/OCI
                    // credential JSON, PEM keys, the OCI PAR backend config-<uuid>.tf, and
                    // cleartext `terraform output -json` dumps alike -- so a crash between
                    // the overwrite and the unlink is the only remaining exposure window
                    // (#595). A scrub failure is surfaced but does not skip the unlink
                    // attempt below.
                    try {
                        scrubFile(filePath);
                    } catch (scrubErr) {
                        tasks.warning(`Failed to scrub temp file ${filePath} before deletion: ${scrubErr}`);
                    }
                    fs.unlinkSync(filePath);
                    tasks.debug(`Cleaned up temp file: ${filePath}`);
                }
            } catch (err) {
                // A leftover credential temp file (OIDC token / GCP or OCI key)
                // is a real exposure on a self-hosted agent -- surface it
                // above debug.
                tasks.warning(`Failed to clean up temp file ${filePath}: ${err}`);
            }
        }
        this.tempFiles = [];

        if (this.secureFileId) {
            try {
                new SecureFileLoader().deleteSecureFile(this.secureFileId);
            } catch (err) {
                tasks.warning(`Failed to clean up secure file: ${err}`);
            }
            this.secureFileId = null;
        }
    }

    /**
     * Writes a terraform command's captured stdout (show/output/custom -- any
     * of which can carry unredacted `sensitive = true` values, most notably
     * `terraform output -json`) to disk with restrictive 0600 permissions
     * instead of the default umask. The parent directory is created first
     * since `show`/`custom` accept a caller-supplied, possibly-nested
     * `filename`. Because that filename is user-supplied and predictable, the
     * write refuses a pre-planted symlink and re-creates the file exclusively
     * (see replaceSecretFile) instead of writing through whatever is already
     * there (#484).
     */
    private writeCommandOutputFile(filePath: string, content: string): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        replaceSecretFile(filePath, content);
    }

    /**
     * Regex patterns anchored to typical `terraform providers` output format.
     * Matches lines like: `provider[registry.terraform.io/hashicorp/aws]`
     */
    private static readonly PROVIDER_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
        ["aws", /provider\[.*\/aws\s*\]/i],
        ["azurerm", /provider\[.*\/azurerm\s*\]/i],
        ["google", /provider\[.*\/google\s*\]/i],
        ["oracle", /provider\[.*\/oci\s*\]/i],
    ]);

    public async warnIfMultipleProviders(): Promise<void> {
        try {
            const binaryName = getBinaryName(tasks);
            const toolPath = resolveToolPath(tasks, binaryName);

            const terraformToolRunner: ToolRunner = tasks.tool(toolPath);
            terraformToolRunner.arg("providers");
            const commandOutput = await this.execWithStdoutCapture(terraformToolRunner, {
                cwd: this.getWorkingDirectory()
            });

            const countProviders = [...BaseTerraformCommandHandler.PROVIDER_PATTERNS.values()]
                .filter(regex => regex.test(commandOutput.stdout)).length;

            tasks.debug(countProviders.toString());
            if (countProviders > 1) {
                tasks.warning("Multiple provider blocks specified in the .tf files in the current working directory.");
            }
        } catch (error) {
            tasks.debug(`Multiple provider check failed (non-fatal): ${String(error)}`);
        }
    }

    protected applyBackendConfig(terraformToolRunner: ToolRunner): void {
        for (const [key, value] of this.backendConfig.entries()) {
            terraformToolRunner.arg(`-backend-config=${key}=${value}`);
        }
    }

    public getServiceProviderNameFromProviderInput(): string {
        const provider: string = tasks.getInput("provider", true)!;

        switch (provider) {
            case "azurerm": return "AzureRM";
            case "aws": return "AWS";
            case "gcp": return "GCP";
            case "oci": return "OCI";
            default: throw new Error(`Unknown provider: ${provider}`);
        }
    }

    public async executeCommand(command: string): Promise<number> {
        const commands: Record<string, () => Promise<number>> = {
            init: () => this.init(),
            validate: () => this.validate(),
            plan: () => this.plan(),
            apply: () => this.apply(),
            destroy: () => this.destroy(),
            show: () => this.show(),
            output: () => this.output(),
            custom: () => this.custom(),
            workspace: () => this.workspace(),
            state: () => this.state(),
            fmt: () => this.fmt(),
            test: () => this.test(),
            get: () => this.get(),
            import: () => this.import(),
            forceunlock: () => this.forceUnlock(),
            refresh: () => this.refresh(),
        };
        const fn = commands[command];
        if (!fn) {
            throw new Error(`Invalid command: ${command}. Valid: ${Object.keys(commands).join(', ')}`);
        }
        return fn();
    }

    // --- Command implementations ---

    public async init(): Promise<number> {
        let commandOptions = this.getCommandOptions();

        if (tasks.getBoolInput("lockfileReadonly", false)) {
            commandOptions = commandOptions ? `-lockfile=readonly ${commandOptions}` : '-lockfile=readonly';
        }

        const initCommand = new TerraformBaseCommandInitializer(
            "init",
            this.getWorkingDirectory(),
            commandOptions
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(initCommand);
        await this.handleBackend(terraformTool);

        return terraformTool.execAsync(<IExecOptions>{
            cwd: initCommand.workingDirectory
        });
    }

    public async show(): Promise<number> {
        const outputTo = tasks.getInput("outputTo");
        const outputFormat = tasks.getInput("outputFormat");
        const commandOptions = this.getCommandOptions();

        let cmd: string;
        if (outputFormat === "json") {
            cmd = commandOptions ? `-json ${commandOptions}` : `-json`;
        } else {
            cmd = commandOptions ? commandOptions : ``;
        }

        const showCommand = this.createAuthCommand("show", cmd);
        const terraformTool = this.terraformToolHandler.createToolRunner(showCommand);
        await this.handleProvider(showCommand);

        let result: number;
        if (outputTo === "console") {
            result = await terraformTool.execAsync(<IExecOptions>{
                cwd: showCommand.workingDirectory
            });
        } else if (outputTo === "file") {
            const showFilePath = path.resolve(showCommand.workingDirectory, tasks.getInput("filename") || '');
            const commandOutput = await this.execWithStdoutCapture(terraformTool, {
                cwd: showCommand.workingDirectory,
            });

            this.writeCommandOutputFile(showFilePath, commandOutput.stdout);
            tasks.setVariable('showFilePath', showFilePath, false, true);

            // Detect destroy changes in JSON plan output
            if (outputFormat === "json") {
                this.detectDestroyChanges(commandOutput.stdout);
                this.warnIfSensitiveOutputs(commandOutput.stdout, showFilePath);
            }

            result = commandOutput.code;
        } else {
            throw new Error("Invalid outputTo value. Must be 'console' or 'file'.");
        }

        // Structured state-inventory path (Phase 5 §5.5): publishStateResults is a
        // NEW opt-in input, so this never runs (and therefore never changes the
        // command line or behavior above) unless it is explicitly set -- the
        // strongest backward-compat guarantee, mirroring publishPlanSummary's own
        // gating. When set, and this show has no plan-file positional argument
        // (hasPositionalCommandArg -- a positional token means this is a planfile
        // show instead, which the existing sensitive-output/destroy-change
        // detection above already covers and which this path leaves untouched),
        // run a SEPARATE `terraform show -json` of the CURRENT state (mirroring
        // publishPlanSummaryAttachment's independent `show -json` call) and attach
        // the redacted StateDigest. Runs after the primary command above so a
        // failing primary command's throw is never masked by this attachment.
        const publishStateResults = tasks.getInput("publishStateResults");
        if (publishStateResults && !hasPositionalCommandArg(commandOptions)) {
            const tempDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
            await this.publishStateSummaryAttachment(showCommand.workingDirectory, publishStateResults, tempDir);
        }

        return result;
    }

    public async output(): Promise<number> {
        const rawCommandOptions = this.getCommandOptions();
        const commandOptions = rawCommandOptions ? `-json ${rawCommandOptions}` : `-json`

        const outputCommand = this.createAuthCommand("output", commandOptions);
        const terraformTool = this.terraformToolHandler.createToolRunner(outputCommand);
        await this.handleProvider(outputCommand);

        // #492: the -json file carries every output's real value in cleartext
        // (including ones declared `sensitive = true`), so write it under
        // Agent.TempDirectory -- which the agent purges at job end -- instead of
        // the repo working directory, where a naive "publish the working
        // directory" artifact step would sweep it up and a self-hosted agent
        // would retain it across jobs. Downstream steps read the location from
        // the `jsonOutputVariablesPath` output variable (the documented
        // contract), so the relocation is transparent to them.
        const outputFileDirectory = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
        const jsonOutputVariablesFilePath = path.join(outputFileDirectory, `output-${uuidV4()}.json`);
        const commandOutput = await this.execWithStdoutCapture(terraformTool, {
            cwd: outputCommand.workingDirectory,
        });

        this.writeCommandOutputFile(jsonOutputVariablesFilePath, commandOutput.stdout);
        tasks.setVariable('jsonOutputVariablesPath', jsonOutputVariablesFilePath, false, true);
        this.warnIfSensitiveOutputFile(commandOutput.stdout, jsonOutputVariablesFilePath);

        if (tasks.getBoolInput('cleanupOutputFile', false)) {
            this.tempFiles.push(jsonOutputVariablesFilePath);
        }

        // Auto-set pipeline variables from terraform output
        this.setOutputVariables(commandOutput.stdout);

        return commandOutput.code;
    }

    public async plan(): Promise<number> {
        const planCommand = this.createAuthCommand("plan");
        const terraformTool = this.terraformToolHandler.createToolRunner(planCommand);

        this.applyTokens(terraformTool, await this.buildLeadingArgs({
            replaceFlag: true, refreshOnly: true, varFiles: true,
            targetResources: true, secureVarFile: true,
        }));
        const commandOptions = this.getCommandOptions();
        if (commandOptions) terraformTool.line(commandOptions);
        terraformTool.arg("-detailed-exitcode");
        this.applyTokens(terraformTool, this.parallelismTokens());
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(planCommand);
        await this.warnIfMultipleProviders();

        const publishPlanResults = tasks.getInput("publishPlanResults");
        const publishPlanSummary = tasks.getInput("publishPlanSummary");
        const tempDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();

        // Structured path (design §7/D1): ensure a plan file exists so the
        // `terraform show -json <planfile>` run below (after this command
        // completes) has something to show. -out is added ONLY when
        // publishPlanSummary is set so a publishPlanResults-only (or neither) run's
        // command line -- and therefore its attachment -- is byte-for-byte
        // unchanged (backward-compat regression, design §12.3).
        //
        // #612: if the user already saves the plan via their own `-out=<path>` in
        // commandOptions, reuse THAT path for the show -json digest instead of
        // injecting a second `-out=`. Terraform honors only the LAST `-out=` on the
        // command line, so a task-injected tempfile would silently shadow the
        // user's file -- the user's artifact plan would never be written, breaking
        // the plan-artifact-then-gated-apply pattern. Reusing the user's path also
        // makes the digest describe the exact plan that later gets applied. The
        // user's path is NOT tracked in `tempFiles`, so end-of-step cleanup never
        // deletes it (neither is the task's own -out tempfile -- both rely on the
        // agent purging Agent.TempDirectory / the working dir at job end).
        let planFilePath: string | undefined;
        if (publishPlanSummary) {
            const userOutPath = extractOutFlagPath(commandOptions);
            if (userOutPath) {
                planFilePath = userOutPath;
            } else {
                planFilePath = path.join(tempDir, `terraform-plan-${uuidV4()}.tfplan`);
                terraformTool.arg(`-out=${planFilePath}`);
            }
        }

        let result: number;
        let planStdout: string | undefined;
        if (publishPlanResults) {
            const commandOutput = await this.execWithStdoutCapture(terraformTool, {
                cwd: planCommand.workingDirectory,
                ignoreReturnCode: true
            });
            result = commandOutput.code;
            planStdout = commandOutput.stdout;
        } else {
            result = await terraformTool.execAsync(<IExecOptions>{
                cwd: planCommand.workingDirectory,
                ignoreReturnCode: true
            });
        }

        if (publishPlanResults && planStdout !== undefined) {
            // Write the attachment into the agent-managed temp directory, which the
            // agent cleans automatically at job end. The agent uploads attachment
            // files asynchronously after reading the ##vso[task.addattachment] line
            // from stdout, so we must NOT add this path to `tempFiles`: cleanupTempFiles()
            // runs in the finally of the parent handler milliseconds later and would
            // unlink the file before the agent has uploaded it, causing the upload to
            // fail with "attachment file does not exist on disk".
            // Written via the 0600/DACL secret-file primitive (#547): the raw plan
            // stdout can carry non-sensitive-but-secret attribute values, and the
            // uuid filename keeps the exclusive create collision-free.
            const attachmentPath = path.join(tempDir, `terraform-plan-${uuidV4()}.txt`);
            writeSecretFile(attachmentPath, planStdout);
            // COMPAT (§ non-negotiable): the legacy terraform-plan-results attachment
            // name is passed RAW, exactly as before the structured-summary feature.
            // azure-pipelines-task-lib's addAttachment already escapes the value into
            // the ##vso[task.addattachment ...;name=NAME;] logging command (see its
            // taskcommand.escape: %/CR/LF/]/; are escaped), so publishPlanResults-only
            // runs stay byte-for-byte identical. sanitizeAttachmentName() (which
            // STRIPS those characters) is applied ONLY to the new -summary attachments,
            // whose name is echoed unescaped into the digest's own meta.name.
            tasks.addAttachment("terraform-plan-results", publishPlanResults, attachmentPath);
        }

        if (publishPlanSummary && planFilePath && (result === 0 || result === 2)) {
            await this.publishPlanSummaryAttachment(planFilePath, planCommand.workingDirectory, publishPlanSummary, tempDir);
        }

        if (result !== 0 && result !== 2) {
            throw new Error(tasks.loc("TerraformPlanFailed", result));
        }
        tasks.setVariable('changesPresent', (result === 2).toString(), false, true);
        return result;
    }

    /**
     * Builds and attaches the redacted PlanDigest (`terraform-plan-summary`) for
     * the structured results path (design §7, D1). Runs `terraform show -json
     * <planFilePath>` against the plan file just produced by `-out`, redacts it
     * via the WP-1 digest core, and writes/attaches it under Agent.TempDirectory.
     * Never fails the task on its own: a problem running or parsing `show -json`
     * is reported as a warning and the attachment is skipped, so the (already
     * succeeded or changes-present) plan result and the raw publishPlanResults
     * attachment, if also requested, are unaffected.
     *
     * `mode` is `"destroy"` when called from destroy() (Phase 5 §5.5 -- a destroy
     * plan is a PlanDigest whose resource_changes are all deletes) so the digest
     * carries `planMode: "destroy"` for the tab to label; omitted (plan) leaves
     * every existing plan() caller byte-unaffected.
     */
    private async publishPlanSummaryAttachment(
        planFilePath: string,
        workingDirectory: string,
        publishName: string,
        tempDir: string,
        mode?: 'destroy',
    ): Promise<void> {
        const showCommand = this.createBaseCommand("show", "-json");
        const showTool = this.terraformToolHandler.createToolRunner(showCommand);
        showTool.arg(planFilePath);

        const showOutput = await this.execWithStdoutCapture(showTool, {
            cwd: workingDirectory,
            ignoreReturnCode: true,
        });
        if (showOutput.code !== 0) {
            tasks.warning(`'terraform show -json' exited with code ${showOutput.code} while building the structured plan summary; skipping the 'terraform-plan-summary' attachment.`);
            return;
        }

        let planJson: unknown;
        try {
            planJson = JSON.parse(showOutput.stdout);
        } catch (error) {
            tasks.warning(`Could not parse 'terraform show -json' output for the structured plan summary; skipping the 'terraform-plan-summary' attachment: ${String(error)}`);
            return;
        }

        const digest = buildPlanDigest(planJson, this.buildDigestMeta(publishName, workingDirectory), mode ? { mode } : undefined);
        this.writeAndAttachDigest('plan', digest, tempDir);
    }

    /**
     * Builds and attaches the redacted StateDigest (`terraform-state-summary`)
     * for the structured state-inventory path (Phase 5 §5.5). Runs a SEPARATE
     * `terraform show -json` (no plan-file argument, so Terraform shows the
     * CURRENT state) independent of the main `show()` command that triggered it,
     * mirroring publishPlanSummaryAttachment's independent `show -json
     * <planFilePath>` call. Never fails the task on its own: a problem running or
     * parsing `show -json`, or building/serializing/attaching the digest, is
     * reported as a warning and the attachment is skipped, exactly like the
     * plan-summary path.
     */
    private async publishStateSummaryAttachment(
        workingDirectory: string,
        publishName: string,
        tempDir: string,
    ): Promise<void> {
        const showCommand = this.createBaseCommand("show", "-json");
        const showTool = this.terraformToolHandler.createToolRunner(showCommand);

        const showOutput = await this.execWithStdoutCapture(showTool, {
            cwd: workingDirectory,
            ignoreReturnCode: true,
        });
        if (showOutput.code !== 0) {
            tasks.warning(`'terraform show -json' exited with code ${showOutput.code} while building the structured state summary; skipping the 'terraform-state-summary' attachment.`);
            return;
        }

        let stateJson: unknown;
        try {
            stateJson = JSON.parse(showOutput.stdout);
        } catch (error) {
            tasks.warning(`Could not parse 'terraform show -json' output for the structured state summary; skipping the 'terraform-state-summary' attachment: ${String(error)}`);
            return;
        }

        // Build + attach is guarded (warn-and-skip) exactly like the show/parse
        // steps above: the structured state summary must NEVER fail the task on
        // its own. buildStateDigest is pure but fails closed by throwing on an
        // unexpected shape, and its size-cap step (capDigestBytes) is the last
        // line of defense against a multi-megabyte state -- so an unexpected
        // throw here degrades to a skipped attachment, not a failed `terraform
        // show` (the caller in show() awaits this with no try/catch of its own).
        try {
            const digest = buildStateDigest(stateJson, this.buildDigestMeta(publishName, workingDirectory));
            this.writeAndAttachDigest('state', digest, tempDir);
        } catch (error) {
            tasks.warning(`Could not build the structured state summary; skipping the 'terraform-state-summary' attachment: ${String(error)}`);
        }
    }

    /**
     * Builds the DigestMeta identity/provenance fields (design §4.1) shared by
     * both the plan and apply structured attachments.
     */
    private buildDigestMeta(publishName: string, workingDirectory: string): DigestMeta {
        return {
            taskVersion: getTaskVersion(),
            toolName: 'terraform',
            name: publishName,
            workingDirectory: relativeWorkingDirectoryForDigest(workingDirectory),
            stage: tasks.getVariable('System.StageDisplayName') || undefined,
            job: tasks.getVariable('System.JobDisplayName') || undefined,
            createdIso: tasks.getVariable('System.PipelineStartTime') || new Date().toISOString(),
        };
    }

    /**
     * Shared tail of the three structured-summary publishers (plan/state/apply):
     * writes the serialized digest to a uuid-named file under tempDir and
     * attaches it as `terraform-<kind>-summary`. Deliberately NOT pushed onto
     * `tempFiles`: the agent uploads attachment files asynchronously after
     * reading the ##vso[task.addattachment] line from stdout, so
     * cleanupTempFiles() would unlink the file before the upload (see the
     * publishPlanResults comment in plan()).
     */
    private writeAndAttachDigest(kind: 'plan' | 'state' | 'apply', digest: Digest, tempDir: string): void {
        const digestPath = path.join(tempDir, `terraform-${kind}-summary-${uuidV4()}.json`);
        fs.writeFileSync(digestPath, serializeDigest(digest), 'utf-8');
        tasks.addAttachment(`terraform-${kind}-summary`, digest.meta.name, digestPath);
    }

    public async custom(): Promise<number> {
        const outputTo = tasks.getInput("outputTo");
        const customCommand = this.createAuthCommand(
            tasks.getInput("customCommand", true)!,
            this.getCommandOptions()
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(customCommand);
        await this.handleProvider(customCommand);

        if (outputTo === "console") {
            return terraformTool.execAsync(<IExecOptions>{
                cwd: customCommand.workingDirectory
            });
        } else if (outputTo === "file") {
            const customFilePath = path.resolve(customCommand.workingDirectory, tasks.getInput("filename") || '');
            const commandOutput = await this.execWithStdoutCapture(terraformTool, {
                cwd: customCommand.workingDirectory
            });

            this.writeCommandOutputFile(customFilePath, commandOutput.stdout);
            tasks.setVariable('customFilePath', customFilePath, false, true);
            return commandOutput.code;
        }
        throw new Error("Invalid outputTo value. Must be 'console' or 'file'.");
    }

    public async apply(): Promise<number> {
        const applyCommand = this.createAuthCommand("apply");
        const terraformTool = this.terraformToolHandler.createToolRunner(applyCommand);

        this.applyTokens(terraformTool, await this.buildLeadingArgs({
            replaceFlag: true, refreshOnly: true, varFiles: true,
            targetResources: true, secureVarFile: true,
        }));

        // Read publishApplyResults BEFORE applyAutoApprove so the structured
        // path's `-json` can be emitted between `-auto-approve` and the (possibly
        // positional plan-file) `commandOptions` -- see #613 and applyAutoApprove's
        // `extraFlags` doc. Appending `-json` after commandOptions (as before)
        // produced `apply -auto-approve <planfile> -json`, which Terraform rejects
        // as "Too many command line arguments" for the standard saved-plan pattern.
        const publishApplyResults = tasks.getInput("publishApplyResults");
        // Structured path (design §7/D2): -json replaces terraform's
        // human-readable apply log, so the raw NDJSON must not hit the console
        // (silent) -- each event's already-human-readable @message is echoed
        // explicitly below instead, preserving the live-log experience while the
        // structured (secret-bearing) fields are consumed only by the redaction
        // pipeline, never printed.
        this.applyAutoApprove(terraformTool, publishApplyResults ? ["-json"] : []);
        this.applyTokens(terraformTool, this.parallelismTokens());
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(applyCommand);
        await this.warnIfMultipleProviders();

        if (!publishApplyResults) {
            return terraformTool.execAsync(<IExecOptions>{
                cwd: applyCommand.workingDirectory
            });
        }

        const commandOutput = await this.execWithStdoutCapture(terraformTool, {
            cwd: applyCommand.workingDirectory,
            silent: true,
            ignoreReturnCode: true,
        });
        this.echoApplyMessages(commandOutput.stdout);

        await this.publishApplySummaryAttachment(commandOutput.stdout, applyCommand.workingDirectory, publishApplyResults);

        // Preserve exit-code semantics exactly: apply still fails the task on a
        // non-zero exit, same as the non-structured path's native execAsync
        // rejection above (ignoreReturnCode was needed here only so a FAILED
        // apply's NDJSON is still available to build the digest's
        // appliedBeforeFailure/diagnostics picture).
        const stderr = commandOutput.stderr.trim();
        if (commandOutput.code !== 0) {
            // #613: with silent:true the ToolRunner does NOT echo Terraform's own
            // output, and CLI usage errors / provider crashes go to STDERR -- not
            // the -json NDJSON stdout stream the digest consumes. Fold the captured
            // stderr into the failure so the cause is never swallowed (the incident
            // showed only a bare "exit code 1" with an empty log).
            throw new Error(stderr
                ? `${tasks.loc("TerraformApplyFailed", commandOutput.code)}\n${stderr}`
                : tasks.loc("TerraformApplyFailed", commandOutput.code));
        }
        // A successful apply may still write warnings to stderr; pass them through
        // at debug level (they are not part of the NDJSON the digest is built from).
        if (stderr) {
            tasks.debug(stderr);
        }
        return commandOutput.code;
    }

    /**
     * Echoes each `apply -json` NDJSON event's `@message` field verbatim to the
     * console so the live log stays human-readable when `-json` replaces
     * Terraform's normal human-readable apply output (design D2/§5.4). Never
     * echoes raw structured event fields -- only the already-human-readable
     * `@message` line Terraform itself produced; the structured fields are
     * consumed only by the redaction pipeline. Malformed lines are skipped
     * silently here -- apply-digest.ts's own parser separately counts and notes
     * them in the digest's truncationNotes.
     */
    private echoApplyMessages(ndjson: string): void {
        for (const rawLine of ndjson.split('\n')) {
            const line = rawLine.replace(/\r$/, '').trim();
            if (!line) continue;
            try {
                const event = JSON.parse(line);
                if (event && typeof event === 'object' && typeof event['@message'] === 'string') {
                    console.log(event['@message']);
                }
            } catch {
                // ignore -- see doc comment above.
            }
        }
    }

    /**
     * Builds and attaches the redacted ApplyDigest (`terraform-apply-summary`)
     * for the structured results path (design §7).
     */
    private async publishApplySummaryAttachment(
        ndjson: string,
        workingDirectory: string,
        publishName: string,
    ): Promise<void> {
        const tempDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
        // includeDiagnostics defaults to FALSE (opt-IN): diagnostics are omitted
        // unless the operator explicitly enables them (safe default — a
        // provider-echoed short secret in a diagnostic must not land in the
        // build-read-readable attachment by default).
        const includeDiagnostics = tasks.getBoolInput('includeDiagnostics', false);
        const options: ApplyDigestOptions = {
            // Operator opt-in for the provider-echoed-secret residual (§5.10): unless
            // explicitly set true, the whole diagnostics array is omitted so no
            // freeform provider text reaches the (build-read-wide) attachment; the
            // failure is still detectable via outcome + the agent-secret-masked live
            // console log.
            includeDiagnostics,
            includeDiagnosticDetail: tasks.getBoolInput('includeDiagnosticDetail', false),
            // §5.4: the task has NO general readback of every secret it registered via
            // setSecret() across the provider handlers, so knownSecrets is [] here and
            // the freeform diagnostic scrub relies on secret-scrub.ts's PEM/high-entropy
            // heuristic ALONE (best-effort; a short provider-echoed secret can still slip
            // through -- documented residual, SECURITY.md / design §5.10). Mitigated by
            // includeDiagnostics (above) and by includeDiagnosticDetail defaulting to
            // false so the more leak-prone 'detail' field is omitted unless opted in.
            knownSecrets: [],
        };

        const digest = buildApplyDigest(ndjson, this.buildDigestMeta(publishName, workingDirectory), options);
        this.writeAndAttachDigest('apply', digest, tempDir);
    }

    public async destroy(): Promise<number> {
        const destroyCommand = this.createAuthCommand("destroy");
        const terraformTool = this.terraformToolHandler.createToolRunner(destroyCommand);

        this.applyTokens(terraformTool, await this.buildLeadingArgs({
            varFiles: true, targetResources: true, secureVarFile: true,
        }));
        this.applyAutoApprove(terraformTool);
        this.applyTokens(terraformTool, this.parallelismTokens());
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(destroyCommand);
        await this.warnIfMultipleProviders();

        const publishPlanSummary = tasks.getInput("publishPlanSummary");
        const tempDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();

        // Structured path (Phase 5 §5.5): a destroy plan IS a PlanDigest whose
        // resource_changes are all deletes, so this reuses buildPlanDigest /
        // publishPlanSummaryAttachment exactly as plan() does above, passing
        // mode:"destroy" so the tab can label the view. -out is added ONLY when
        // publishPlanSummary is set (same gating as plan()'s -out), so a run with
        // neither publish input set has a byte-for-byte unchanged command line
        // (backward-compat, design §12.3 applied to destroy).
        //
        // #612 (sibling): destroy DOES forward commandOptions -- applyAutoApprove()
        // above emits them via `terraformTool.line(commandOptions)` -- so the same
        // last-`-out=`-wins collision applies here. Honor a user-supplied `-out=`
        // identically to plan(): reuse it for the show -json digest and inject no
        // second `-out=`.
        let planFilePath: string | undefined;
        if (publishPlanSummary) {
            const userOutPath = extractOutFlagPath(this.getCommandOptions());
            if (userOutPath) {
                planFilePath = userOutPath;
            } else {
                planFilePath = path.join(tempDir, `terraform-destroy-${uuidV4()}.tfplan`);
                terraformTool.arg(`-out=${planFilePath}`);
            }
        }

        if (!publishPlanSummary) {
            return terraformTool.execAsync(<IExecOptions>{
                cwd: destroyCommand.workingDirectory
            });
        }

        // ignoreReturnCode is needed ONLY so a FAILED destroy's already-written
        // plan file (terraform writes -out during planning, before the
        // auto-approved apply phase runs) is still available to build+attach the
        // structured summary below -- mirrors apply()'s identical
        // ignoreReturnCode/manual-throw pattern for the same reason (design D2).
        // Destroy still auto-approves and still fails the task on a non-zero exit
        // exactly as the non-structured path above.
        const result = await terraformTool.execAsync(<IExecOptions>{
            cwd: destroyCommand.workingDirectory,
            ignoreReturnCode: true,
        });

        await this.publishPlanSummaryAttachment(planFilePath!, destroyCommand.workingDirectory, publishPlanSummary, tempDir, 'destroy');

        if (result !== 0) {
            throw new Error(tasks.loc("TerraformDestroyFailed", result));
        }
        return result;
    }

    /**
     * Forces `-auto-approve` on the tool runner (apply/destroy), then applies any
     * free-form `commandOptions`. If the user already supplied `-auto-approve` in
     * `commandOptions`, it is not added a second time.
     *
     * `extraFlags` are emitted AFTER `-auto-approve` but BEFORE `commandOptions`.
     * This ordering matters for #613: for the standard saved-plan apply pattern
     * `commandOptions` is a POSITIONAL plan-file path, and Terraform's flag parser
     * stops at the first positional argument -- so a flag (e.g. `-json`) appended
     * after `commandOptions` is rejected as a second positional ("Too many command
     * line arguments"). Placing such flags here guarantees they precede the
     * positional. Defaults to none, so destroy()'s call is byte-for-byte unchanged.
     */
    private applyAutoApprove(terraformTool: ToolRunner, extraFlags: string[] = []): void {
        const commandOptions = this.getCommandOptions();
        if (!commandOptions || !commandOptions.includes('-auto-approve')) {
            terraformTool.arg('-auto-approve');
        }
        for (const flag of extraFlags) {
            terraformTool.arg(flag);
        }
        if (commandOptions) terraformTool.line(commandOptions);
    }

    public async validate(): Promise<number> {
        const validateCommand = this.createBaseCommand(
            "validate",
            this.getCommandOptions()
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(validateCommand);

        return terraformTool.execAsync(<IExecOptions>{
            cwd: validateCommand.workingDirectory
        });
    }

    public async workspace(): Promise<number> {
        const subCommand = tasks.getInput("workspaceSubCommand", true)!;
        const workspaceName = tasks.getInput("workspaceName", false);
        const commandOptions = this.getCommandOptions();

        const additionalArgs = workspaceName
            ? `${workspaceName}${commandOptions ? ` ${commandOptions}` : ''}`
            : commandOptions || undefined;

        const workspaceCommand = this.createBaseCommand(
            `workspace ${subCommand}`,
            additionalArgs
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(workspaceCommand);
        return terraformTool.execAsync(<IExecOptions>{
            cwd: workspaceCommand.workingDirectory
        });
    }

    public async state(): Promise<number> {
        const subCommand = tasks.getInput("stateSubCommand", true)!;
        const stateAddress = tasks.getInput("stateAddress", false);
        const commandOptions = this.getCommandOptions();

        if (subCommand === 'push') {
            tasks.warning("terraform state push is a potentially destructive operation. Ensure you have a current backup of your state file.");
        }

        const parts: string[] = [];
        if (commandOptions) { parts.push(commandOptions); }
        if (stateAddress) { parts.push(stateAddress); }

        const stateCommand = this.createBaseCommand(
            `state ${subCommand}`,
            parts.length > 0 ? parts.join(' ') : undefined
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(stateCommand);
        return terraformTool.execAsync(<IExecOptions>{
            cwd: stateCommand.workingDirectory
        });
    }

    public async fmt(): Promise<number> {
        let args = "";
        if (tasks.getBoolInput("fmtCheck", false)) { args += " -check"; }
        if (tasks.getBoolInput("fmtRecursive", false)) { args += " -recursive"; }
        if (tasks.getBoolInput("fmtDiff", false)) { args += " -diff"; }
        const commandOptions = this.getCommandOptions();
        if (commandOptions) { args += ` ${commandOptions}`; }

        const fmtCommand = this.createBaseCommand(
            "fmt",
            args.trim() || undefined
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(fmtCommand);
        return terraformTool.execAsync(<IExecOptions>{
            cwd: fmtCommand.workingDirectory
        });
    }

    public async test(): Promise<number> {
        let commandOptions = this.getCommandOptions();

        const junitPath = tasks.getInput("testJunitXmlPath", false);
        if (junitPath) {
            commandOptions = commandOptions ? `${commandOptions} -junit-xml=${junitPath}` : `-junit-xml=${junitPath}`;
        }

        const testFilter = tasks.getInput("testFilter", false);
        if (testFilter) {
            commandOptions = commandOptions ? `${commandOptions} -filter=${testFilter}` : `-filter=${testFilter}`;
        }

        // Service connection is optional for test. Unit/validation tests don't need
        // provider auth, but integration tests (run blocks with command = apply) may.
        const serviceName = tasks.getInput(this.getServiceName(), false);
        if (serviceName) {
            const testCommand = this.createAuthCommand("test", commandOptions);
            const terraformTool = this.terraformToolHandler.createToolRunner(testCommand);
            await this.handleProvider(testCommand);
            return terraformTool.execAsync(<IExecOptions>{
                cwd: testCommand.workingDirectory
            });
        }

        const testCommand = this.createBaseCommand("test", commandOptions);
        const terraformTool = this.terraformToolHandler.createToolRunner(testCommand);
        return terraformTool.execAsync(<IExecOptions>{
            cwd: testCommand.workingDirectory
        });
    }

    public async get(): Promise<number> {
        const getCommand = this.createBaseCommand(
            "get",
            this.getCommandOptions()
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(getCommand);
        return terraformTool.execAsync(<IExecOptions>{
            cwd: getCommand.workingDirectory
        });
    }

    public async import(): Promise<number> {
        const resourceAddress = tasks.getInput("importAddress", true)!;
        const resourceId = tasks.getInput("importId", true)!;

        const importCommand = this.createAuthCommand("import");
        const terraformTool = this.terraformToolHandler.createToolRunner(importCommand);

        this.applyTokens(terraformTool, await this.buildLeadingArgs({
            varFiles: true, secureVarFile: true,
        }));
        const commandOptions = this.getCommandOptions();
        if (commandOptions) terraformTool.line(commandOptions);
        // Address and id are passed as discrete argv entries so an id containing
        // spaces is not split.
        terraformTool.arg(resourceAddress);
        terraformTool.arg(resourceId);
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(importCommand);

        return terraformTool.execAsync(<IExecOptions>{
            cwd: importCommand.workingDirectory
        });
    }

    public async forceUnlock(): Promise<number> {
        const lockId = tasks.getInput("lockId", true)!;
        const commandOptions = this.getCommandOptions();

        tasks.warning("terraform force-unlock removes the lock on the state for the current configuration. This will allow other users or automation to acquire the lock and potentially modify the state.");

        const args = commandOptions
            ? `-force ${commandOptions} ${lockId}`
            : `-force ${lockId}`;

        const unlockCommand = this.createBaseCommand("force-unlock", args);
        const terraformTool = this.terraformToolHandler.createToolRunner(unlockCommand);
        return terraformTool.execAsync(<IExecOptions>{
            cwd: unlockCommand.workingDirectory
        });
    }

    public async refresh(): Promise<number> {
        const refreshCommand = this.createAuthCommand("refresh");
        const terraformTool = this.terraformToolHandler.createToolRunner(refreshCommand);

        this.applyTokens(terraformTool, await this.buildLeadingArgs({
            varFiles: true, targetResources: true, secureVarFile: true,
        }));
        const commandOptions = this.getCommandOptions();
        if (commandOptions) terraformTool.line(commandOptions);
        this.applyTokens(terraformTool, this.parallelismTokens());
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(refreshCommand);

        return terraformTool.execAsync(<IExecOptions>{
            cwd: refreshCommand.workingDirectory
        });
    }

    // --- Pipeline variable helpers ---

    /**
     * State/output content a compromised module or provider can fully
     * control must not reach tasks.setVariable() unsanitized: a value
     * containing control characters (e.g. an embedded newline) could forge
     * additional ADO logging commands in the console output that consumes
     * this variable downstream. Also caps length as a sanity bound.
     */
    private sanitizeOutputVariableValue(value: string): string | null {
        if (!value || value.length > BaseTerraformCommandHandler.OUTPUT_VAR_MAX_LENGTH) return null;
        return /^[\x20-\x7E]+$/.test(value) ? value : null;
    }

    private setOutputVariables(jsonOutput: string): void {
        try {
            const outputs = JSON.parse(jsonOutput);
            for (const [key, outputDef] of Object.entries(outputs)) {
                const def = outputDef as { value?: unknown; sensitive?: boolean; type?: unknown };
                if (def.value === undefined) continue;

                const stringValue = typeof def.value === 'object'
                    ? JSON.stringify(def.value)
                    : String(def.value);

                const safeValue = this.sanitizeOutputVariableValue(stringValue);
                if (safeValue === null) {
                    tasks.warning(`Output '${key}' failed output-variable validation (length/printable-ASCII); skipping TF_OUT_${key}.`);
                    continue;
                }

                const isSecret = def.sensitive === true;
                tasks.setVariable(`TF_OUT_${key}`, safeValue, isSecret, true);
                tasks.debug(`Set pipeline variable TF_OUT_${key}${isSecret ? ' (secret)' : ''}`);
            }
        } catch (err) {
            tasks.debug(`Could not parse terraform output as JSON for pipeline variables: ${err}`);
        }
    }

    private detectDestroyChanges(jsonOutput: string): void {
        try {
            const plan = JSON.parse(jsonOutput);
            const resourceChanges = plan.resource_changes;
            if (!Array.isArray(resourceChanges)) return;

            const hasDestroy = resourceChanges.some((rc: { change?: { actions?: string[] } }) =>
                rc.change?.actions?.includes('delete')
            );
            tasks.setVariable('destroyChangesPresent', hasDestroy.toString(), false, true);
            if (hasDestroy) {
                tasks.warning("Terraform plan contains resource deletions. Review carefully before applying.");
            }
        } catch (err) {
            tasks.warning(`Could not parse terraform show output for destroy-change detection; the deletion safety warning did not run: ${err}`);
        }
    }

    /**
     * Detects `sensitive = true` outputs (and resource attributes) in a
     * `terraform show -json` plan written to `filePath`. Warns by default;
     * when the opt-in `failOnSensitiveOutputs` input is set, sensitive
     * *outputs* instead fail the task (#488) -- the just-written file is
     * registered for end-of-step deletion first so the cleartext values are
     * not left behind by the failure. Sensitive resource *attributes* stay
     * warning-only even in strict mode: nearly every real plan carries some,
     * so failing on them would make the strict mode unusable.
     */
    private warnIfSensitiveOutputs(jsonOutput: string, filePath: string): void {
        let plan: { planned_values?: { outputs?: unknown }, resource_changes?: unknown };
        try {
            plan = JSON.parse(jsonOutput);
        } catch (error) {
            tasks.warning(`Could not parse terraform plan for sensitive-output detection; the sensitive-value safety warning did not run: ${String(error)}`);
            return;
        }

        // Check for sensitive values in planned_values outputs. maskHasSensitiveLeaf
        // shares its "mask === true at any depth" predicate with the WP-1 redaction
        // core (design §5.2.7) so this detection cannot silently drift from what the
        // structured digest actually redacts.
        const outputs = plan?.planned_values?.outputs;
        if (outputs && typeof outputs === 'object') {
            const sensitiveKeys = Object.entries(outputs)
                .filter(([, v]) => maskHasSensitiveLeaf((v as { sensitive?: unknown }).sensitive))
                .map(([k]) => k);
            if (sensitiveKeys.length > 0) {
                if (tasks.getBoolInput('failOnSensitiveOutputs', false)) {
                    this.tempFiles.push(filePath);
                    throw new Error(tasks.loc('ShowSensitiveOutputsStrictFailure', filePath, sensitiveKeys.length, sensitiveKeys.join(', ')));
                }
                tasks.warning(`Terraform plan output file contains ${sensitiveKeys.length} sensitive output(s): ${sensitiveKeys.join(', ')}. Ensure this file is not published as a pipeline artifact.`);
            }
        }

        // Check for sensitive attributes in resource changes. Recursive (via
        // maskHasSensitiveLeaf) so sensitivity nested under an object/array mask is
        // caught too, not just a top-level `{key: true}` entry -- the previous
        // one-level-only scan could miss it.
        const resourceChanges = plan?.resource_changes;
        if (Array.isArray(resourceChanges)) {
            const sensitiveResources = resourceChanges.filter((rc: { change?: { after_sensitive?: unknown } }) =>
                maskHasSensitiveLeaf(rc.change?.after_sensitive)
            );
            if (sensitiveResources.length > 0) {
                tasks.warning(`Terraform plan contains ${sensitiveResources.length} resource(s) with sensitive attributes. The output file may contain unredacted secrets.`);
            }
        }
    }

    /**
     * `terraform output -json` emits every output's real value in cleartext,
     * including ones declared `sensitive = true` in configuration (Terraform
     * only redacts the human-readable console format, not `-json`). Warn
     * loudly when that's the case so the file written by
     * writeCommandOutputFile() -- restrictive permissions and its job-purged
     * Agent.TempDirectory location (#492) notwithstanding -- doesn't get
     * casually published as a build artifact or left for a downstream step to
     * mishandle before the agent purges it at job end. When the opt-in
     * `failOnSensitiveOutputs` input is set and cleanup was NOT requested via
     * `cleanupOutputFile`, the task fails instead (#488) -- the just-written
     * file is registered for end-of-step deletion first so the failure
     * doesn't leave the cleartext values behind. With `cleanupOutputFile` set
     * the file is deleted at step end anyway, so strict mode stays a warning.
     */
    private warnIfSensitiveOutputFile(jsonOutput: string, filePath: string): void {
        let outputs: unknown;
        try {
            outputs = JSON.parse(jsonOutput);
        } catch (error) {
            tasks.debug(`Could not parse terraform output as JSON for sensitive-output detection: ${error}`);
            return;
        }
        if (!outputs || typeof outputs !== 'object') return;

        const sensitiveKeys = Object.entries(outputs)
            .filter(([, def]) => (def as { sensitive?: boolean }).sensitive === true)
            .map(([key]) => key);
        if (sensitiveKeys.length === 0) return;

        if (tasks.getBoolInput('failOnSensitiveOutputs', false) && !tasks.getBoolInput('cleanupOutputFile', false)) {
            this.tempFiles.push(filePath);
            throw new Error(tasks.loc('OutputSensitiveOutputsStrictFailure', filePath, sensitiveKeys.length, sensitiveKeys.join(', ')));
        }
        tasks.warning(
            `${filePath} contains ${sensitiveKeys.length} sensitive output(s) in cleartext (${sensitiveKeys.join(', ')}). ` +
            `Ensure this file is not published as a pipeline artifact. Set 'cleanupOutputFile' to remove it automatically ` +
            `at the end of this step if downstream steps don't need to read it from disk.`
        );
    }
}
