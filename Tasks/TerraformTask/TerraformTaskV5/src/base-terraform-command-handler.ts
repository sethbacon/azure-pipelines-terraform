import { TerraformToolHandler, ITerraformToolHandler, getBinaryName } from './terraform';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformBaseCommandInitializer, TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { getSecureVarFileArgs, SecureFileLoader } from './secure-file-loader';
import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { randomUUID as uuidV4 } from 'crypto';
import fs = require('fs');
import os = require('os');

/** Validates Terraform resource addresses (e.g. `aws_instance.foo`, `module.bar["key"]`). */
export const RESOURCE_ADDRESS_RE = /^[a-zA-Z_][\w\-]*(\[[^\]]+\])?(\.[a-zA-Z_][\w\-]*(\[[^\]]+\])?)*$/;

/**
 * Splits a multi-line `varFile` input into `-var-file=<path>` tokens, one per
 * non-empty line. Each path is kept whole so it can be passed as a single argv
 * entry — paths containing spaces (common on Windows agents) must not be split.
 */
export function parseVarFileTokens(varFile: string | undefined): string[] {
    if (!varFile) return [];
    return varFile.split('\n').map(l => l.trim()).filter(l => l).map(f => `-var-file=${f}`);
}

/**
 * Splits a multi-line `targetResources` input into validated `-target=<address>`
 * tokens. Addresses may legitimately contain spaces inside quoted index keys
 * (e.g. `module.x["a b"]`), so each is kept as a single argv entry.
 */
export function parseTargetTokens(targetResources: string | undefined): string[] {
    if (!targetResources) return [];
    const lines = targetResources.split('\n').map(l => l.trim()).filter(l => l);
    for (const address of lines) {
        if (!RESOURCE_ADDRESS_RE.test(address)) {
            throw new Error(`Invalid target address '${address}': must be a valid Terraform resource address`);
        }
    }
    return lines.map(a => `-target=${a}`);
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

    abstract handleBackend(terraformToolRunner: ToolRunner): Promise<void>;
    abstract handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void>;

    constructor() {
        this.providerName = "";
        this.terraformToolHandler = new TerraformToolHandler(tasks);
        this.backendConfig = new Map<string, string>();
        this.tempFiles = [];
    }

    // --- Helper methods to reduce duplication ---

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

        for (const line of variables.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                terraformTool.arg('-var');
                terraformTool.arg(trimmed);
            }
        }
    }

    // --- Core infrastructure ---

    protected async execWithStdoutCapture(terraformTool: ToolRunner, options: IExecOptions): Promise<{ code: number; stdout: string }> {
        let stdout = '';
        terraformTool.on('stdout', (data: string | Buffer) => {
            stdout += data.toString();
        });

        const code = await terraformTool.execAsync(options);

        return { code, stdout };
    }

    public cleanupTempFiles(): void {
        for (const filePath of this.tempFiles) {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    tasks.debug(`Cleaned up temp file: ${filePath}`);
                }
            } catch (err) {
                tasks.debug(`Failed to clean up temp file ${filePath}: ${err}`);
            }
        }
        this.tempFiles = [];

        if (this.secureFileId) {
            try {
                new SecureFileLoader().deleteSecureFile(this.secureFileId);
            } catch (err) {
                tasks.debug(`Failed to clean up secure file: ${err}`);
            }
            this.secureFileId = null;
        }
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
            let toolPath;
            try {
                toolPath = tasks.which(binaryName, true);
            } catch {
                throw new Error(tasks.loc("TerraformToolNotFound"));
            }

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
        let commandOptions = tasks.getInput("commandOptions");

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

        let cmd: string;
        if (outputFormat === "json") {
            cmd = tasks.getInput("commandOptions") ? `-json ${tasks.getInput("commandOptions")}` : `-json`;
        } else {
            cmd = tasks.getInput("commandOptions") ? tasks.getInput("commandOptions")! : ``;
        }

        const showCommand = this.createAuthCommand("show", cmd);
        const terraformTool = this.terraformToolHandler.createToolRunner(showCommand);
        await this.handleProvider(showCommand);

        if (outputTo === "console") {
            return terraformTool.execAsync(<IExecOptions>{
                cwd: showCommand.workingDirectory
            });
        } else if (outputTo === "file") {
            const showFilePath = path.resolve(showCommand.workingDirectory, tasks.getInput("filename") || '');
            const commandOutput = await this.execWithStdoutCapture(terraformTool, {
                cwd: showCommand.workingDirectory,
            });

            tasks.writeFile(showFilePath, commandOutput.stdout);
            tasks.setVariable('showFilePath', showFilePath, false, true);

            // Detect destroy changes in JSON plan output
            if (outputFormat === "json") {
                this.detectDestroyChanges(commandOutput.stdout);
                this.warnIfSensitiveOutputs(commandOutput.stdout);
            }

            return commandOutput.code;
        }
        throw new Error("Invalid outputTo value. Must be 'console' or 'file'.");
    }

    public async output(): Promise<number> {
        const commandOptions = tasks.getInput("commandOptions") ? `-json ${tasks.getInput("commandOptions")}` : `-json`

        const outputCommand = this.createAuthCommand("output", commandOptions);
        const terraformTool = this.terraformToolHandler.createToolRunner(outputCommand);
        await this.handleProvider(outputCommand);

        const jsonOutputVariablesFilePath = path.resolve(outputCommand.workingDirectory, `output-${uuidV4()}.json`);
        const commandOutput = await this.execWithStdoutCapture(terraformTool, {
            cwd: outputCommand.workingDirectory,
        });

        tasks.writeFile(jsonOutputVariablesFilePath, commandOutput.stdout);
        tasks.setVariable('jsonOutputVariablesPath', jsonOutputVariablesFilePath, false, true);

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
        const commandOptions = tasks.getInput("commandOptions");
        if (commandOptions) terraformTool.line(commandOptions);
        terraformTool.arg("-detailed-exitcode");
        this.applyTokens(terraformTool, this.parallelismTokens());
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(planCommand);
        await this.warnIfMultipleProviders();

        const publishPlanResults = tasks.getInput("publishPlanResults");

        let result: number;
        if (publishPlanResults) {
            const commandOutput = await this.execWithStdoutCapture(terraformTool, {
                cwd: planCommand.workingDirectory,
                ignoreReturnCode: true
            });
            result = commandOutput.code;

            // Write the attachment into the agent-managed temp directory, which the
            // agent cleans automatically at job end. The agent uploads attachment
            // files asynchronously after reading the ##vso[task.addattachment] line
            // from stdout, so we must NOT add this path to `tempFiles`: cleanupTempFiles()
            // runs in the finally of the parent handler milliseconds later and would
            // unlink the file before the agent has uploaded it, causing the upload to
            // fail with "attachment file does not exist on disk".
            const attachmentDir = tasks.getVariable("Agent.TempDirectory") || os.tmpdir();
            const attachmentPath = path.join(attachmentDir, `terraform-plan-${uuidV4()}.txt`);
            fs.writeFileSync(attachmentPath, commandOutput.stdout, "utf-8");
            tasks.addAttachment("terraform-plan-results", publishPlanResults, attachmentPath);
        } else {
            result = await terraformTool.execAsync(<IExecOptions>{
                cwd: planCommand.workingDirectory,
                ignoreReturnCode: true
            });
        }

        if (result !== 0 && result !== 2) {
            throw new Error(tasks.loc("TerraformPlanFailed", result));
        }
        tasks.setVariable('changesPresent', (result === 2).toString(), false, true);
        return result;
    }

    public async custom(): Promise<number> {
        const outputTo = tasks.getInput("outputTo");
        const customCommand = this.createAuthCommand(
            tasks.getInput("customCommand", true)!,
            tasks.getInput("commandOptions")
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

            tasks.writeFile(customFilePath, commandOutput.stdout);
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
        this.applyAutoApprove(terraformTool);
        this.applyTokens(terraformTool, this.parallelismTokens());
        this.appendTerraformVariables(terraformTool);

        await this.handleProvider(applyCommand);
        await this.warnIfMultipleProviders();

        return terraformTool.execAsync(<IExecOptions>{
            cwd: applyCommand.workingDirectory
        });
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

        return terraformTool.execAsync(<IExecOptions>{
            cwd: destroyCommand.workingDirectory
        });
    }

    /**
     * Forces `-auto-approve` on the tool runner (apply/destroy), then applies any
     * free-form `commandOptions`. If the user already supplied `-auto-approve` in
     * `commandOptions`, it is not added a second time.
     */
    private applyAutoApprove(terraformTool: ToolRunner): void {
        const commandOptions = tasks.getInput("commandOptions");
        if (!commandOptions || !commandOptions.includes('-auto-approve')) {
            terraformTool.arg('-auto-approve');
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
        const commandOptions = tasks.getInput("commandOptions");

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
        const commandOptions = tasks.getInput("commandOptions");

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
        const commandOptions = tasks.getInput("commandOptions");
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
        let commandOptions = tasks.getInput("commandOptions");

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
        const commandOptions = tasks.getInput("commandOptions");
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
        const commandOptions = tasks.getInput("commandOptions");

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

    private setOutputVariables(jsonOutput: string): void {
        try {
            const outputs = JSON.parse(jsonOutput);
            for (const [key, outputDef] of Object.entries(outputs)) {
                const def = outputDef as { value?: unknown; sensitive?: boolean; type?: unknown };
                if (def.value === undefined) continue;

                const stringValue = typeof def.value === 'object'
                    ? JSON.stringify(def.value)
                    : String(def.value);

                const isSecret = def.sensitive === true;
                tasks.setVariable(`TF_OUT_${key}`, stringValue, isSecret, true);
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
            tasks.debug(`Could not parse terraform show output for destroy detection: ${err}`);
        }
    }

    private warnIfSensitiveOutputs(jsonOutput: string): void {
        try {
            const plan = JSON.parse(jsonOutput);

            // Check for sensitive values in planned_values outputs
            const outputs = plan.planned_values?.outputs;
            if (outputs && typeof outputs === 'object') {
                const sensitiveKeys = Object.entries(outputs)
                    .filter(([, v]) => (v as { sensitive?: boolean }).sensitive === true)
                    .map(([k]) => k);
                if (sensitiveKeys.length > 0) {
                    tasks.warning(`Terraform plan output file contains ${sensitiveKeys.length} sensitive output(s): ${sensitiveKeys.join(', ')}. Ensure this file is not published as a pipeline artifact.`);
                }
            }

            // Check for sensitive attributes in resource changes
            const resourceChanges = plan.resource_changes;
            if (Array.isArray(resourceChanges)) {
                const sensitiveResources = resourceChanges.filter((rc: { change?: { after_sensitive?: unknown } }) => {
                    const afterSensitive = rc.change?.after_sensitive;
                    if (!afterSensitive || typeof afterSensitive !== 'object') return false;
                    return Object.values(afterSensitive as Record<string, unknown>).some(v => v === true);
                });
                if (sensitiveResources.length > 0) {
                    tasks.warning(`Terraform plan contains ${sensitiveResources.length} resource(s) with sensitive attributes. The output file may contain unredacted secrets.`);
                }
            }
        } catch (error) {
            tasks.debug(`Failed to check sensitive outputs: ${String(error)}`);
        }
    }
}
