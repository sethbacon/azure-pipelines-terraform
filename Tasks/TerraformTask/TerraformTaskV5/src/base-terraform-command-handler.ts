import { TerraformToolHandler, ITerraformToolHandler, getBinaryName, resolveToolPath } from './terraform';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformBaseCommandInitializer, TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { writeSecretFile } from './secure-temp';
import { TempFileManager } from './temp-file-manager';
import {
    ArgumentBuilder,
    splitNonEmptyLines,
    hasPositionalCommandArg,
    extractOutFlagPath,
    commandOptionsContainsJsonFlag,
} from './argument-builder';
import { CommandExecutor } from './command-executor';
import { ResultsPublisher } from './results-publisher';
import { buildPlanDigest } from './results/plan-digest';
import { buildStateDigest } from './results/state-digest';
import { maskHasSensitiveLeaf } from './results/redact';
import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';
import os = require('os');

// Digest provenance helpers moved to `src/results-publisher.ts` (#878);
// re-exported so this module's exported surface is unchanged.
export { getTaskVersion, relativeWorkingDirectoryForDigest } from './results-publisher';

// Argument construction moved to `src/argument-builder.ts` (#878). These are
// re-exported because Tests/ and generic-terraform-command-handler.ts import them
// from here; the entry point is preserved so this refactor stays behaviour-only.
export {
    ArgumentBuilder,
    RESOURCE_ADDRESS_RE,
    splitNonEmptyLines,
    parseVarFileTokens,
    parseTargetTokens,
    splitCommandOptions,
    hasPositionalCommandArg,
    extractOutFlagPath,
    commandOptionsContainsJsonFlag,
} from './argument-builder';

// `warnIfSensitiveOutputs`'s sensitivity detection is the SAME predicate the WP-1
// redaction core applies (design §5.2.7): rather than re-derive it here (the
// detection-vs-redaction drift class, #446), it is defined ONCE in
// `src/results/redact.ts` beside `redactNode` and re-exported here so existing
// importers (Tests/MaskHasSensitiveLeafL0.ts) keep their entry point.
export { maskHasSensitiveLeaf };



// Capture-size ceilings moved to `src/command-executor.ts` (#878).
// MAX_CAPTURED_STDOUT_BYTES is re-exported because Tests/ExecStdoutCaptureL0.ts
// imports it from here.
export { MAX_CAPTURED_STDOUT_BYTES, MAX_CAPTURED_MESSAGE_BYTES } from './command-executor';

/**
 * Single abstract base carrying every terraform sub-command (init/plan/apply/...)
 * plus the auth plumbing shared by all provider handlers. The size is a
 * deliberate cohesion trade-off: the provider subclasses (azure/aws/gcp/oci/hcp/
 * generic) override only handleBackend()/handleProvider() and inherit one identical
 * command-execution path, which is exactly what keeps provider behavior consistent.
 *
 * #878 is decomposing the rest. Extracted so far: temp-file lifecycle
 * ({@link TempFileManager}), argv/flag building ({@link ArgumentBuilder}),
 * command execution ({@link CommandExecutor}) and results publishing
 * ({@link ResultsPublisher}). What remains is the per-command implementations
 * themselves plus provider-detection output parsing. Each step is a pure
 * refactor with no behavior change.
 */
export abstract class BaseTerraformCommandHandler {
    providerName: string;
    terraformToolHandler: ITerraformToolHandler;
    backendConfig: Map<string, string>;
    // The only mutable state this class had, now owned by its own collaborator (#878).
    protected readonly tempFileManager = new TempFileManager();
    // Argv construction, likewise (#878). It needs the temp-file manager because a
    // downloaded secure var file must be recorded for later scrubbing.
    protected readonly argumentBuilder = new ArgumentBuilder(this.tempFileManager);
    // Command execution, timeouts and failure formatting (#878). Stateless, so
    // the subclasses that call execWithTimeout share this instance harmlessly.
    protected readonly commandExecutor = new CommandExecutor();
    // Turning command output into attachments, variables, files and warnings
    // (#878). Takes the temp-file manager so a strict sensitivity failure can
    // register the cleartext file it just inspected before throwing.
    protected readonly resultsPublisher = new ResultsPublisher(this.tempFileManager);

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

    /**
     * Hook invoked after `terraform init`'s `execAsync` SETTLES — whether it
     * resolved or rejected. `init()` below runs this from a `finally` around
     * that `execAsync` (#675 follow-up): `execAsync` is called with no
     * `ignoreReturnCode`, so a non-zero exit REJECTS the promise, and a bare
     * `await this.afterInit()` placed only after it (the pre-fix shape) would
     * never run once the backend was configured but a later phase of init
     * (e.g. provider install) failed — silently skipping any default-secure
     * hardening of whatever init already wrote to disk before failing.
     * `initFailed` is true on the reject path, so an override can go
     * best-effort/warn there (never mask init's own error, which `init()`
     * always re-throws unchanged after this hook returns) while staying
     * fail-closed (throwing) on the success path. No-op by default; overridden
     * by the OCI handler (#675) to default-secure the OCI PAR bearer
     * credential `terraform init` caches into `.terraform/terraform.tfstate`,
     * independent of the separate opt-in `cleanupOCIBackendCache` flag (which
     * instead governs that same cache's full scrub+delete via the ordinary
     * tempFiles/cleanupTempFiles path).
     */
    protected async afterInit(_initFailed: boolean): Promise<void> {
        // No-op by default — see TerraformCommandHandlerOCI.afterInit override.
    }

    /**
     * Hook invoked after `plan()`/`destroy()` (directly, or via
     * `runDestroyPlanForSummary()`) finish running the terraform command that
     * writes a saved plan file to `planFilePath` -- whether that command
     * succeeded or not (`commandFailed` mirrors `afterInit`'s `initFailed`).
     * `planFilePath` may be either a task-generated tempfile or a
     * user-supplied `-out=` path (see `extractOutFlagPath`); both are handled
     * identically here. No-op by default; overridden by the OCI handler
     * (#675 follow-up) for the same reason as `afterInit`: Terraform's
     * config-snapshot plan format embeds the ACTIVE backend config -- including
     * an OCI PAR bearer URL -- into every saved plan file, not just
     * `.terraform/terraform.tfstate`, so a plan/destroy step run against an
     * already-`init`-ed OCI PAR backend leaves an equally-live credential in
     * whatever `-out=` file this produced, regardless of the in-process-only
     * `cleanupOCIBackendCache`/afterInit state (plan/destroy commonly run as a
     * separate pipeline step -- a separate process -- from the `init` that
     * originally configured the backend).
     */
    protected async afterPlanFileWritten(_planFilePath: string, _commandFailed: boolean): Promise<void> {
        // No-op by default — see TerraformCommandHandlerOCI.afterPlanFileWritten override.
    }

    constructor() {
        this.providerName = "";
        this.terraformToolHandler = new TerraformToolHandler(tasks);
        this.backendConfig = new Map<string, string>();
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

    /**
     * Reads and validates a `*AuthScheme*` input in one call: defaults to
     * "ServiceConnection" when omitted, then validates via
     * {@link validateAuthScheme}. This exact "read input, default, validate"
     * shape was previously copy-pasted verbatim at 7 call sites across the
     * AWS/GCP/OCI handlers (issue #682) -- centralized here so a future change
     * to the default value or validation call shape has one place to update.
     */
    protected resolveAuthScheme(inputName: string): string {
        const scheme = tasks.getInput(inputName, false) || "ServiceConnection";
        this.validateAuthScheme(scheme, inputName);
        return scheme;
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

    /**
     * Tracks a temp path for scrub+delete. Kept on the base class because three
     * cloud subclasses register their own credential files through it.
     */
    protected trackTempFile(filePath: string): void {
        this.tempFileManager.track(filePath);
    }

    /** End-of-step cleanup (normal completion). */
    public cleanupTempFiles(): void {
        this.tempFileManager.cleanup();
    }

    /**
     * Cancellation cleanup (SIGTERM/SIGINT/uncaughtException, via
     * ParentCommandHandler.emergencyCleanup). Must stay synchronous: it runs from
     * a process-level signal handler, where a returned promise would not be
     * awaited before the process exits.
     */
    public emergencyCleanupTempFiles(): void {
        this.tempFileManager.emergencyCleanup();
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
            const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformToolRunner, {
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

        // #675 follow-up: afterInit() must run whether this execAsync resolves
        // OR rejects. There is no `ignoreReturnCode` here, so a non-zero exit
        // (e.g. the backend configured successfully but a later provider-install
        // phase failed) REJECTS the promise -- a bare `await this.afterInit()`
        // placed only after it (the pre-fix shape) would then never run, even
        // though the backend-configuration phase already wrote whatever
        // afterInit() needs to harden. The `finally` guarantees afterInit() always
        // runs; the original error (if any) is re-thrown unchanged afterward so
        // init's own failure is never masked or replaced.
        let result: number | undefined;
        let initError: unknown;
        try {
            result = await this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
                cwd: initCommand.workingDirectory
            });
        } catch (error) {
            initError = error;
        } finally {
            await this.afterInit(initError !== undefined);
        }

        if (initError !== undefined) {
            throw initError;
        }

        return result!;
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
            // #492 follow-up (audit id0): `show -json` cleartext must never reach
            // the console unredacted-and-unwarned the way the file branch below
            // already guards against -- capture silently first (never a raw
            // execAsync, which would mirror the child's stdout before we can
            // inspect it), run the SAME sensitive-value detection the file path
            // uses, and only THEN echo. Under the opt-in failOnSensitiveOutputs,
            // warnIfSensitiveOutputs throws before anything is echoed, so the
            // console path fully PREVENTS the leak rather than merely warning
            // after the fact (there is no file to clean up here, unlike the file
            // branch, since nothing has touched disk).
            const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformTool, {
                cwd: showCommand.workingDirectory,
            });
            if (outputFormat === "json") {
                this.resultsPublisher.warnIfSensitiveOutputs(commandOutput.stdout, undefined);
            }
            // #869: route through echoSafeConsoleLine, same as plan()/apply() --
            // captured show output can carry provider/module/remote-state text, and
            // an unneutralized leading `##vso[...]`/`##[...]` line would otherwise
            // forge an ADO logging command.
            this.resultsPublisher.echoSafeConsoleLine(commandOutput.stdout);
            if (commandOutput.stderr.trim()) {
                tasks.debug(commandOutput.stderr.trim());
            }
            result = commandOutput.code;
        } else if (outputTo === "file") {
            const showFilePath = path.resolve(showCommand.workingDirectory, tasks.getInput("filename") || '');
            // ignoreReturnCode mirrors packer's build()/fix() fix (#202/#203, same
            // class): without it a non-zero `terraform show` REJECTS here and the
            // already-captured stdout is discarded, so the file the operator asked
            // for is never written and showFilePath is never exported -- even
            // though the output exists. The non-zero code is re-surfaced as an
            // explicit failure below, after the file and variable are in place.
            const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformTool, {
                cwd: showCommand.workingDirectory,
                ignoreReturnCode: true,
            });

            this.resultsPublisher.writeCommandOutputFile(showFilePath, commandOutput.stdout);
            const safeShowFilePath = this.resultsPublisher.sanitizeOutputVariableValue(showFilePath);
            if (safeShowFilePath) {
                tasks.setVariable('showFilePath', safeShowFilePath, false, true);
            } else {
                tasks.warning(`showFilePath '${showFilePath}' failed output-variable validation (length/printable-ASCII); skipping the showFilePath output variable.`);
            }

            // Detect destroy changes in JSON plan output
            if (outputFormat === "json") {
                this.resultsPublisher.detectDestroyChanges(commandOutput.stdout);
                const hasSensitive = this.resultsPublisher.warnIfSensitiveOutputs(commandOutput.stdout, showFilePath);
                // #802: a `show -json` file lands at the operator-chosen `filename`
                // (by default inside the working directory, unlike output()'s
                // Agent.TempDirectory temp file), so a "publish the working directory"
                // artifact step could sweep up its cleartext sensitive values. Mirror
                // output()'s #650 handling: when the file contains sensitive content,
                // auto-register it for NORMAL-completion scrub+delete
                // (cleanupShowFileIfSensitive, default true) unless the operator opts
                // out because a downstream step in the SAME job still needs to read
                // it -- in which case it still gets the emergency-only scrub+delete on
                // a cancellation, where no legitimate downstream reader remains.
                if (hasSensitive) {
                    if (tasks.getBoolInput('cleanupShowFileIfSensitive', false)) {
                        this.tempFileManager.track(showFilePath);
                    } else {
                        this.tempFileManager.trackEmergencyOnly(showFilePath);
                    }
                }
            }

            result = commandOutput.code;
            if (result !== 0) {
                // Re-raised only now that the output file and showFilePath exist
                // (#202/#203 class): failing is still the right outcome, losing the
                // captured output on the way there was not.
                throw new Error(`Terraform show failed with exit code ${result}.`);
            }
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
        // Same #202/#203 class as show()/custom(): a rejecting exec would discard
        // the captured stdout before it is written and before
        // jsonOutputVariablesPath is exported. Capture the code, persist, then fail.
        const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformTool, {
            cwd: outputCommand.workingDirectory,
            ignoreReturnCode: true,
        });

        this.resultsPublisher.writeCommandOutputFile(jsonOutputVariablesFilePath, commandOutput.stdout);
        const safeOutputVariablesPath = this.resultsPublisher.sanitizeOutputVariableValue(jsonOutputVariablesFilePath);
        if (safeOutputVariablesPath) {
            tasks.setVariable('jsonOutputVariablesPath', safeOutputVariablesPath, false, true);
        } else {
            tasks.warning(`jsonOutputVariablesPath '${jsonOutputVariablesFilePath}' failed output-variable validation (length/printable-ASCII); skipping the jsonOutputVariablesPath output variable.`);
        }
        const hasSensitiveOutputs = this.resultsPublisher.warnIfSensitiveOutputFile(commandOutput.stdout, jsonOutputVariablesFilePath);

        // #650: a file containing sensitive output values is auto-registered for
        // NORMAL-completion scrub+delete (cleanupOutputFileIfSensitive, default
        // true) even when the general-purpose cleanupOutputFile wasn't requested
        // -- unless the operator explicitly opts out (e.g. a downstream step in
        // the SAME job still needs to read this specific sensitive value from
        // disk). Otherwise, cleanupOutputFile is off: the file must survive a
        // NORMAL step so downstream steps can still read it via the
        // jsonOutputVariablesPath contract, but on a cancellation there is no
        // legitimate downstream reader left -- register it for the
        // emergency-only scrub+delete path so its cleartext values aren't left
        // on a reused self-hosted agent's temp dir until job end.
        if (tasks.getBoolInput('cleanupOutputFile', false) ||
            (hasSensitiveOutputs && tasks.getBoolInput('cleanupOutputFileIfSensitive', false))) {
            this.tempFileManager.track(jsonOutputVariablesFilePath);
        } else {
            this.tempFileManager.trackEmergencyOnly(jsonOutputVariablesFilePath);
        }

        // Auto-set pipeline variables from terraform output
        this.resultsPublisher.setOutputVariables(commandOutput.stdout);

        if (commandOutput.code !== 0) {
            throw new Error(`Terraform output failed with exit code ${commandOutput.code}.`);
        }
        return commandOutput.code;
    }

    public async plan(): Promise<number> {
        const planCommand = this.createAuthCommand("plan");
        const terraformTool = this.terraformToolHandler.createToolRunner(planCommand);

        this.argumentBuilder.applyTokens(terraformTool, await this.argumentBuilder.buildLeadingArgs({
            replaceFlag: true, refreshOnly: true, varFiles: true,
            targetResources: true, secureVarFile: true,
        }));
        const commandOptions = this.getCommandOptions();
        if (commandOptions) terraformTool.line(commandOptions);
        terraformTool.arg("-detailed-exitcode");
        this.argumentBuilder.applyTokens(terraformTool, this.argumentBuilder.parallelismTokens());
        this.argumentBuilder.appendTerraformVariables(terraformTool);

        await this.handleProvider(planCommand);
        await this.warnIfMultipleProviders();

        const publishPlanResults = tasks.getInput("publishPlanResults");
        const publishPlanSummary = tasks.getInput("publishPlanSummary");
        const tempDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();

        // Structured path (design §7/D1): ensure a plan file exists so the
        // `terraform show -json <planfile>` run below (after this command
        // completes) has something to show. The task's OWN -out is injected
        // ONLY when publishPlanSummary is set so a publishPlanResults-only (or
        // neither) run's command line -- and therefore its attachment -- is
        // byte-for-byte unchanged (backward-compat regression, design §12.3).
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
        //
        // #675 2nd follow-up: detecting the user's own `-out=` must NOT be gated
        // on publishPlanSummary. commandOptions (and any -out= inside it) is
        // applied to the command line unconditionally, above -- so a bare
        // `commandOptions: -out=<path>` run with publishPlanSummary unset still
        // writes a real plan file, which embeds the active backend config (an OCI
        // PAR bearer URL included) exactly like the publishPlanSummary-injected
        // tempfile does. planFilePath must be populated in that case too, so
        // afterPlanFileWritten() below (which OCI overrides to permission-tighten
        // the file) actually runs. Only the task's OWN tempfile *injection*
        // remains gated on publishPlanSummary; the digest/attachment behavior
        // below, which separately checks publishPlanSummary, is unchanged.
        let planFilePath: string | undefined = extractOutFlagPath(commandOptions);
        if (publishPlanSummary && !planFilePath) {
            planFilePath = path.join(tempDir, `terraform-plan-${uuidV4()}.tfplan`);
            terraformTool.arg(`-out=${planFilePath}`);
        }

        let result: number;
        let planStdout: string | undefined;
        let planStderr: string | undefined;
        if (publishPlanResults) {
            // #492 follow-up: publishPlanResults re-echoes its capture to the
            // console below on the assumption that it is terraform's
            // human-readable plan output, which redacts sensitive values as
            // "(sensitive value)" -- but a user-supplied -json in
            // commandOptions would make that capture raw, unredacted NDJSON
            // instead. Fail closed before ever running the command rather
            // than silently reproducing the exact leak #492 fixed.
            if (commandOptionsContainsJsonFlag(commandOptions)) {
                throw new Error(tasks.loc("PlanJsonFlagNotSupportedWithPublishPlanResults"));
            }
            const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformTool, {
                cwd: planCommand.workingDirectory,
                ignoreReturnCode: true
            });
            result = commandOutput.code;
            planStdout = commandOutput.stdout;
            planStderr = commandOutput.stderr.trim() || undefined;
            // The capture above is silent (#492), so echo the captured
            // human-readable plan back to the console ourselves -- terraform's
            // human plan format already prints `(sensitive value)` for values
            // declared sensitive, which is what makes this echo safe while the
            // `output -json` / `show -json` captures must never be echoed.
            // Route through echoSafeConsoleLine (audit id9), same as apply()'s
            // echoApplyMessages: plan output can carry provider/module/remote-state
            // -controlled text, and a line beginning `##vso[...]`/`##[...]` would
            // otherwise forge an ADO logging command (#678's fix closed this for
            // apply; the plan echo was the sibling path it never covered).
            this.resultsPublisher.echoSafeConsoleLine(planStdout);
        } else {
            result = await this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
                cwd: planCommand.workingDirectory,
                ignoreReturnCode: true
            });
        }

        // #675 follow-up: tighten planFilePath's permissions (OCI PAR backends
        // only; no-op elsewhere) as soon as this command finishes writing it --
        // regardless of the exit code, since a plan file embeds the active
        // backend config the same way `.terraform/terraform.tfstate` does. Runs
        // before the publishPlanResults/publishPlanSummary attachments below so
        // neither ever reads/re-shows a file some OTHER process could have
        // gotten to first.
        if (planFilePath) {
            await this.afterPlanFileWritten(planFilePath, result !== 0 && result !== 2);
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
            // On the silent publishPlanResults path terraform's own error text
            // (stderr) no longer reaches the log via the ToolRunner echo -- fold
            // it into the failure exactly like apply() does (#613).
            this.commandExecutor.throwCommandFailure("TerraformPlanFailed", result, planStderr ? [planStderr] : []);
        }
        // A successful plan may still write warnings to stderr; with the silent
        // capture they would otherwise vanish -- pass them through at debug level
        // (mirrors apply()).
        if (planStderr) {
            tasks.debug(planStderr);
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

        const showOutput = await this.commandExecutor.execWithStdoutCapture(showTool, {
            cwd: workingDirectory,
            ignoreReturnCode: true,
        });
        if (showOutput.code !== 0) {
            // The capture is silent (#492), so include the captured stderr --
            // otherwise the failure's cause never reaches the log (#613).
            const stderrDetail = showOutput.stderr.trim();
            tasks.warning(`'terraform show -json' exited with code ${showOutput.code} while building the structured plan summary; skipping the 'terraform-plan-summary' attachment.${stderrDetail ? ` terraform stderr: ${stderrDetail}` : ''}`);
            return;
        }

        let planJson: unknown;
        try {
            planJson = JSON.parse(showOutput.stdout);
        } catch (error) {
            tasks.warning(`Could not parse 'terraform show -json' output for the structured plan summary; skipping the 'terraform-plan-summary' attachment: ${String(error)}`);
            return;
        }

        const digest = buildPlanDigest(planJson, this.resultsPublisher.buildDigestMeta(publishName, workingDirectory), mode ? { mode } : undefined);
        this.resultsPublisher.writeAndAttachDigest('plan', digest, tempDir);
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

        const showOutput = await this.commandExecutor.execWithStdoutCapture(showTool, {
            cwd: workingDirectory,
            ignoreReturnCode: true,
        });
        if (showOutput.code !== 0) {
            // The capture is silent (#492), so include the captured stderr --
            // otherwise the failure's cause never reaches the log (#613).
            const stderrDetail = showOutput.stderr.trim();
            tasks.warning(`'terraform show -json' exited with code ${showOutput.code} while building the structured state summary; skipping the 'terraform-state-summary' attachment.${stderrDetail ? ` terraform stderr: ${stderrDetail}` : ''}`);
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
            const digest = buildStateDigest(stateJson, this.resultsPublisher.buildDigestMeta(publishName, workingDirectory));
            this.resultsPublisher.writeAndAttachDigest('state', digest, tempDir);
        } catch (error) {
            tasks.warning(`Could not build the structured state summary; skipping the 'terraform-state-summary' attachment: ${String(error)}`);
        }
    }



    public async custom(): Promise<number> {
        const outputTo = tasks.getInput("outputTo");
        const commandOptions = this.getCommandOptions();
        const customCommand = this.createAuthCommand(
            tasks.getInput("customCommand", true)!,
            commandOptions
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(customCommand);
        await this.handleProvider(customCommand);

        // #675 sibling: `customCommand: plan` (or `plan -destroy`) plus a
        // user-supplied `-out=` in commandOptions writes a real saved-plan file
        // through this same free-text passthrough -- Terraform doesn't care that
        // the task labels the step "custom" rather than "plan". Detected
        // unconditionally, exactly like plan()'s own unconditional
        // extractOutFlagPath() call (#675 2nd follow-up); no customCommand
        // parsing needed since afterPlanFileWritten() is already a safe no-op
        // (via fs.existsSync) when planFilePath doesn't exist -- i.e. every
        // non-plan custom command. Wrapped in try/catch/finally mirroring
        // init()'s identical afterInit() pattern: a failing custom command still
        // leaves this block by throwing (the console path REJECTS, the file path
        // re-raises its own captured code after persisting its output) -- the hook
        // must still run on that path, and the original error is re-thrown
        // unchanged afterward.
        const planFilePath = extractOutFlagPath(commandOptions);
        let result: number | undefined;
        let customError: unknown;
        try {
            if (outputTo === "console") {
                result = await this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
                    cwd: customCommand.workingDirectory
                });
            } else if (outputTo === "file") {
                const customFilePath = path.resolve(customCommand.workingDirectory, tasks.getInput("filename") || '');
                // #202/#203 class: the try/finally above only guarantees the
                // afterPlanFileWritten hook on a rejecting exec -- the write and
                // the customFilePath export sit AFTER the await inside the try, so
                // a non-zero exit skipped both and silently discarded the captured
                // output. Persist first, then re-raise the failure below.
                const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformTool, {
                    cwd: customCommand.workingDirectory,
                    ignoreReturnCode: true,
                });

                this.resultsPublisher.writeCommandOutputFile(customFilePath, commandOutput.stdout);
                const safeCustomFilePath = this.resultsPublisher.sanitizeOutputVariableValue(customFilePath);
                if (safeCustomFilePath) {
                    tasks.setVariable('customFilePath', safeCustomFilePath, false, true);
                } else {
                    tasks.warning(`customFilePath '${customFilePath}' failed output-variable validation (length/printable-ASCII); skipping the customFilePath output variable.`);
                }
                // #868: customCommand is free-form, so its output shape is unknown --
                // only attempt sensitive-value detection when the operator's own
                // commandOptions requested -json (mirrors show()'s outputFormat==="json"
                // gate; custom has no outputFormat input of its own). Always register
                // the file for cleanup -- normal-completion when sensitive (no dedicated
                // cleanupCustomFile* opt-out exists, so this defaults to the safer
                // path), emergency-only otherwise -- since neither collection was ever
                // populated for this branch before.
                const hasSensitive = commandOptionsContainsJsonFlag(commandOptions) &&
                    this.resultsPublisher.warnIfSensitiveOutputs(commandOutput.stdout, customFilePath);
                if (hasSensitive) {
                    this.tempFileManager.track(customFilePath);
                } else {
                    this.tempFileManager.trackEmergencyOnly(customFilePath);
                }
                result = commandOutput.code;
                if (result !== 0) {
                    throw new Error(`Terraform custom command failed with exit code ${result}.`);
                }
            } else {
                throw new Error("Invalid outputTo value. Must be 'console' or 'file'.");
            }
        } catch (error) {
            customError = error;
        } finally {
            if (planFilePath) {
                await this.afterPlanFileWritten(planFilePath, customError !== undefined);
            }
        }

        if (customError !== undefined) {
            throw customError;
        }

        return result!;
    }

    public async apply(): Promise<number> {
        const applyCommand = this.createAuthCommand("apply");
        const terraformTool = this.terraformToolHandler.createToolRunner(applyCommand);

        this.argumentBuilder.applyTokens(terraformTool, await this.argumentBuilder.buildLeadingArgs({
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
        this.argumentBuilder.applyTokens(terraformTool, this.argumentBuilder.parallelismTokens());
        this.argumentBuilder.appendTerraformVariables(terraformTool);

        await this.handleProvider(applyCommand);
        await this.warnIfMultipleProviders();

        if (!publishApplyResults) {
            return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
                cwd: applyCommand.workingDirectory
            });
        }

        const commandOutput = await this.commandExecutor.execWithStdoutCapture(terraformTool, {
            cwd: applyCommand.workingDirectory,
            silent: true,
            ignoreReturnCode: true,
        });
        this.resultsPublisher.echoApplyMessages(commandOutput.stdout);

        await this.resultsPublisher.publishApplySummaryAttachment(commandOutput.stdout, applyCommand.workingDirectory, publishApplyResults);

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
            //
            // #750: under -json, a real terraform CLI-level failure (e.g. an
            // unreadable saved plan file) is instead reported as a `diagnostic`
            // event on STDOUT, not stderr -- the stderr-fold above alone never
            // sees it, reproducing the exact "bare exit code, no cause" problem
            // #613 fixed, just via the one path that fix didn't cover. Fold any
            // error-severity diagnostic summaries from the NDJSON alongside
            // stderr.
            const errorDiagnostics = this.resultsPublisher.extractApplyErrorDiagnostics(commandOutput.stdout);
            this.commandExecutor.throwCommandFailure("TerraformApplyFailed", commandOutput.code, [...errorDiagnostics, ...(stderr ? [stderr] : [])]);
        }
        // A successful apply may still write warnings to stderr; pass them through
        // at debug level (they are not part of the NDJSON the digest is built from).
        if (stderr) {
            tasks.debug(stderr);
        }
        return commandOutput.code;
    }





    public async destroy(): Promise<number> {
        const destroyCommand = this.createAuthCommand("destroy");
        const terraformTool = this.terraformToolHandler.createToolRunner(destroyCommand);

        this.argumentBuilder.applyTokens(terraformTool, await this.argumentBuilder.buildLeadingArgs({
            varFiles: true, targetResources: true, secureVarFile: true,
        }));
        this.applyAutoApprove(terraformTool);
        this.argumentBuilder.applyTokens(terraformTool, this.argumentBuilder.parallelismTokens());
        this.argumentBuilder.appendTerraformVariables(terraformTool);

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
        // #749: unlike plan(), destroy() cannot inject its OWN `-out=` on the
        // real destroy command -- real `terraform destroy` is a convenience
        // alias for `terraform apply -destroy`, and apply does not accept
        // `-out=` at all (a plan-only concept: -out SAVES a new plan file;
        // apply/destroy CONSUME one or run interactively, neither ever produces
        // one). A prior fix injected `-out=` here anyway, which real terraform
        // rejected outright ("flag provided but not defined: -out") every time
        // destroy + publishPlanSummary were used together.
        //
        // #612 (sibling): honor a user-supplied `-out=` in commandOptions
        // identically to plan() -- reuse it for the show -json digest and run
        // no separate plan of our own. (Real terraform destroy would itself
        // reject a user's own `-out=` the same way, so this only matters if an
        // operator is relying on destroy silently ignoring an `-out=` they
        // also pass to other commands via a shared commandOptions value.)
        let planFilePath: string | undefined;
        if (publishPlanSummary) {
            const userOutPath = extractOutFlagPath(this.getCommandOptions());
            if (userOutPath) {
                planFilePath = userOutPath;
            } else {
                // Run a SEPARATE, real `terraform plan -destroy -out=<file>` to
                // produce a genuine destroy-plan file for the digest -- the same
                // shape of extra, independent terraform invocation
                // publishStateSummaryAttachment() already runs for show(). Runs
                // BEFORE the real destroy below, using the same leading args
                // (var files/target resources/secure var file) so the preview
                // matches what destroy is about to do.
                planFilePath = path.join(tempDir, `terraform-destroy-${uuidV4()}.tfplan`);
                await this.runDestroyPlanForSummary(planFilePath, destroyCommand.workingDirectory);
            }
        }

        if (!publishPlanSummary) {
            return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
                cwd: destroyCommand.workingDirectory
            });
        }

        // ignoreReturnCode: a FAILED destroy should still get its
        // pre-destroy plan digest attached below (useful context for the
        // failure) -- mirrors apply()'s identical ignoreReturnCode/manual-throw
        // pattern for the same reason (design D2). Destroy still auto-approves
        // and still fails the task on a non-zero exit exactly as the
        // non-structured path above.
        const result = await this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: destroyCommand.workingDirectory,
            ignoreReturnCode: true,
        });

        // #675 follow-up: same reasoning as plan()'s call above. Also covers
        // the user-supplied `-out=` case (#612, above) that
        // runDestroyPlanForSummary() never touches -- redundant-but-harmless
        // (idempotent) for the task-tempfile case, which runDestroyPlanForSummary()
        // already tightened itself immediately after producing it.
        await this.afterPlanFileWritten(planFilePath!, result !== 0);

        await this.publishPlanSummaryAttachment(planFilePath!, destroyCommand.workingDirectory, publishPlanSummary, tempDir, 'destroy');

        if (result !== 0) {
            this.commandExecutor.throwCommandFailure("TerraformDestroyFailed", result);
        }
        return result;
    }

    /**
     * Runs a SEPARATE, real `terraform plan -destroy -out=<planFilePath>` to
     * produce a genuine destroy-plan file for destroy()'s publishPlanSummary
     * digest (#749). Real `terraform destroy` (a convenience alias for `apply
     * -destroy`) does not accept `-out=` at all, unlike plan()'s single-command
     * `-out=` injection -- destroy's structured summary needs this independent
     * plan invocation before the real (auto-approved, `-out`-free) destroy runs.
     * Uses the same leading args (var files/target resources/secure var file)
     * destroy() itself applies, so the preview matches what destroy is about to
     * do; deliberately does NOT forward destroy's own commandOptions (which may
     * carry destroy-specific flags plan doesn't accept) beyond that.
     *
     * Fails loudly (throws) rather than silently degrading like
     * publishPlanSummaryAttachment's own `show -json` failures do: a failure
     * here means the working directory itself can't produce a valid plan (bad
     * HCL, backend issue), and proceeding to a real destroy blind would be
     * unsafe.
     */
    private async runDestroyPlanForSummary(planFilePath: string, workingDirectory: string): Promise<void> {
        const planCommand = this.createBaseCommand("plan", `-destroy -out=${planFilePath}`);
        const planTool = this.terraformToolHandler.createToolRunner(planCommand);
        this.argumentBuilder.applyTokens(planTool, await this.argumentBuilder.buildLeadingArgs({
            varFiles: true, targetResources: true, secureVarFile: true,
        }));
        this.argumentBuilder.appendTerraformVariables(planTool);

        const result = await this.commandExecutor.execWithTimeout(planTool, <IExecOptions>{
            cwd: workingDirectory,
            ignoreReturnCode: true,
        });
        // #675 follow-up: tighten planFilePath's permissions (OCI PAR backends
        // only; no-op elsewhere) immediately after THIS sub-plan produces it --
        // before the throw below, so a failing sub-plan (result !== 0 && !== 2)
        // still gets the file it may have already written hardened rather than
        // skipped, mirroring init()'s own try/finally reasoning.
        await this.afterPlanFileWritten(planFilePath, result !== 0 && result !== 2);
        if (result !== 0 && result !== 2) {
            throw new Error(tasks.loc("TerraformDestroyPlanForSummaryFailed", result));
        }
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

        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
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
        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
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
        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: stateCommand.workingDirectory
        });
    }

    public async fmt(): Promise<number> {
        const fmtCheck = tasks.getBoolInput("fmtCheck", false);
        let args = "";
        if (fmtCheck) { args += " -check"; }
        if (tasks.getBoolInput("fmtRecursive", false)) { args += " -recursive"; }
        if (tasks.getBoolInput("fmtDiff", false)) { args += " -diff"; }
        const commandOptions = this.getCommandOptions();
        if (commandOptions) { args += ` ${commandOptions}`; }

        const fmtCommand = this.createBaseCommand(
            "fmt",
            args.trim() || undefined
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(fmtCommand);

        // #826: stdout and stderr are captured into SEPARATE buffers (not one
        // shared buffer) via ADDITIVE listeners -- not execWithStdoutCapture,
        // which forces `silent: true` and would suppress the live console echo
        // this command has always had -- so a non-zero exit can be
        // differentiated instead of the bare ToolRunner default, mirroring
        // TerraformDocsV1's --output-check handling. `-check` reports
        // unformatted files as a plain filename-per-line list on STDOUT with no
        // error diagnostic (confirmed by this task's own FmtFail fixture); a
        // genuine crash (bad HCL, permissions, ...) writes its diagnostic to
        // STDERR instead and produces no stdout -- so "not formatted" is keyed
        // off stdout specifically, not merely "was ANYTHING captured" (which
        // previously misclassified a stderr-only crash as unformatted files).
        // Any other non-zero exit falls back to a generic message with BOTH
        // captured streams folded in, same as plan()/apply()'s existing
        // stderr-fold precedent (#613).
        const capture = this.commandExecutor.captureMessageStreams(terraformTool);

        const code = await this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: fmtCommand.workingDirectory,
            ignoreReturnCode: true,
        });

        if (code !== 0) {
            if (fmtCheck) {
                const files = splitNonEmptyLines(capture.stdout());
                if (files.length > 0) {
                    throw new Error(tasks.loc("TerraformFmtNotFormatted", files.length));
                }
            }
            this.commandExecutor.throwCommandFailure("TerraformFmtFailed", code, [capture.stdout().trim(), capture.stderr().trim()]);
        }
        return code;
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
            return this.runTestCommand(terraformTool, testCommand.workingDirectory);
        }

        const testCommand = this.createBaseCommand("test", commandOptions);
        const terraformTool = this.terraformToolHandler.createToolRunner(testCommand);
        return this.runTestCommand(terraformTool, testCommand.workingDirectory);
    }

    /**
     * Runs `terraform test` with bounded stdout/stderr capture (ADDITIVE
     * listeners -- not execWithStdoutCapture, so the live console echo this
     * command has always had is preserved) so a non-zero exit's failure
     * message carries the actual terraform detail instead of the bare
     * ToolRunner default (#826) -- mirrors plan()/apply()'s existing
     * stderr-fold precedent (#613). Unlike fmt()'s `-check` case, `terraform
     * test` has no single well-known machine-checkable marker distinguishing
     * "tests ran and some failed" from "the test command itself crashed" in
     * its human-readable output, so this does not attempt to synthesize a
     * pass/fail count -- it surfaces the captured detail either way, which is
     * the actionable improvement the issue asks for without guessing at an
     * unverified output format. Streams are captured separately (mirroring
     * fmt()'s #826 fix) purely so a verbose stdout test report can't crowd a
     * genuinely useful stderr diagnostic out of the shared byte budget --
     * both are still folded into the one TerraformTestFailed message either
     * way; there is no classification/message-choice difference like fmt()'s.
     */
    private async runTestCommand(terraformTool: ToolRunner, workingDirectory: string): Promise<number> {
        const capture = this.commandExecutor.captureMessageStreams(terraformTool);

        const code = await this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: workingDirectory,
            ignoreReturnCode: true,
        });

        if (code !== 0) {
            this.commandExecutor.throwCommandFailure("TerraformTestFailed", code, [capture.stdout().trim(), capture.stderr().trim()]);
        }
        return code;
    }

    public async get(): Promise<number> {
        const getCommand = this.createBaseCommand(
            "get",
            this.getCommandOptions()
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(getCommand);
        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: getCommand.workingDirectory
        });
    }

    public async import(): Promise<number> {
        const resourceAddress = tasks.getInput("importAddress", true)!;
        const resourceId = tasks.getInput("importId", true)!;

        const importCommand = this.createAuthCommand("import");
        const terraformTool = this.terraformToolHandler.createToolRunner(importCommand);

        this.argumentBuilder.applyTokens(terraformTool, await this.argumentBuilder.buildLeadingArgs({
            varFiles: true, secureVarFile: true,
        }));
        const commandOptions = this.getCommandOptions();
        if (commandOptions) terraformTool.line(commandOptions);
        // Address and id are passed as discrete argv entries so an id containing
        // spaces is not split.
        terraformTool.arg(resourceAddress);
        terraformTool.arg(resourceId);
        this.argumentBuilder.appendTerraformVariables(terraformTool);

        await this.handleProvider(importCommand);

        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
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
        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: unlockCommand.workingDirectory
        });
    }

    public async refresh(): Promise<number> {
        const refreshCommand = this.createAuthCommand("refresh");
        const terraformTool = this.terraformToolHandler.createToolRunner(refreshCommand);

        this.argumentBuilder.applyTokens(terraformTool, await this.argumentBuilder.buildLeadingArgs({
            varFiles: true, targetResources: true, secureVarFile: true,
        }));
        const commandOptions = this.getCommandOptions();
        if (commandOptions) terraformTool.line(commandOptions);
        this.argumentBuilder.applyTokens(terraformTool, this.argumentBuilder.parallelismTokens());
        this.argumentBuilder.appendTerraformVariables(terraformTool);

        await this.handleProvider(refreshCommand);

        return this.commandExecutor.execWithTimeout(terraformTool, <IExecOptions>{
            cwd: refreshCommand.workingDirectory
        });
    }

    // --- Pipeline variable helpers ---





}
