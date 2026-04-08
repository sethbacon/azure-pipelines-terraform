import { TerraformToolHandler, ITerraformToolHandler, getBinaryName } from './terraform';
import { ToolRunner, IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformBaseCommandInitializer, TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { getSecureVarFileArgs } from './secure-file-loader';
import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { v4 as uuidV4 } from 'uuid';
import fs = require('fs');

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

    protected ensureAutoApprove(args: string | undefined): string {
        const autoApprove = '-auto-approve';
        let result = args || autoApprove;
        if (!result.includes(autoApprove)) {
            result = `${autoApprove} ${result}`;
        }
        return result;
    }

    protected prependReplaceFlag(args: string): string {
        const replaceAddress = tasks.getInput("replaceAddress", false);
        if (replaceAddress) {
            return `-replace=${replaceAddress} ${args}`;
        }
        return args;
    }

    protected prependRefreshOnly(args: string): string {
        if (tasks.getBoolInput("refreshOnly", false)) {
            return `-refresh-only ${args}`;
        }
        return args;
    }

    protected appendParallelism(args: string): string {
        const parallelism = tasks.getInput("parallelism", false);
        if (parallelism) {
            return `${args} -parallelism=${parallelism}`;
        }
        return args;
    }

    protected async appendSecureVarFile(args: string): Promise<string> {
        const result = await getSecureVarFileArgs();
        if (result) {
            this.secureFileId = result.secureFileId;
            return `${result.varFileArg} ${args}`;
        }
        return args;
    }

    protected appendTerraformVariables(args: string): string {
        const variables = tasks.getInput("terraformVariables", false);
        if (!variables) return args;

        const varArgs: string[] = [];
        for (const line of variables.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                varArgs.push(`-var '${trimmed}'`);
            }
        }
        if (varArgs.length > 0) {
            return `${varArgs.join(' ')} ${args}`;
        }
        return args;
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
                const { SecureFileLoader } = require('./secure-file-loader');
                new SecureFileLoader().deleteSecureFile(this.secureFileId);
            } catch (err) {
                tasks.debug(`Failed to clean up secure file: ${err}`);
            }
            this.secureFileId = null;
        }
    }

    public async warnIfMultipleProviders(): Promise<void> {
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

        const countProviders = ["aws", "azurerm", "google", "oracle"].filter(provider => commandOutput.stdout.includes(provider)).length;

        tasks.debug(countProviders.toString());
        if (countProviders > 1) {
            tasks.warning("Multiple provider blocks specified in the .tf files in the current working directory.");
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
            cmd = tasks.getInput("commandOptions") ? `-json  ${tasks.getInput("commandOptions")}` : `-json`;
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
        let commandOptions = tasks.getInput("commandOptions") ? `${tasks.getInput("commandOptions")} -detailed-exitcode` : `-detailed-exitcode`;
        commandOptions = this.prependReplaceFlag(commandOptions);
        commandOptions = this.prependRefreshOnly(commandOptions);
        commandOptions = this.appendParallelism(commandOptions);
        commandOptions = await this.appendSecureVarFile(commandOptions);
        commandOptions = this.appendTerraformVariables(commandOptions);

        const planCommand = this.createAuthCommand("plan", commandOptions);
        const terraformTool = this.terraformToolHandler.createToolRunner(planCommand);
        await this.handleProvider(planCommand);
        await this.warnIfMultipleProviders();

        const result = await terraformTool.execAsync(<IExecOptions>{
            cwd: planCommand.workingDirectory,
            ignoreReturnCode: true
        });

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
        let additionalArgs = this.ensureAutoApprove(tasks.getInput("commandOptions"));
        additionalArgs = this.prependReplaceFlag(additionalArgs);
        additionalArgs = this.prependRefreshOnly(additionalArgs);
        additionalArgs = this.appendParallelism(additionalArgs);
        additionalArgs = await this.appendSecureVarFile(additionalArgs);
        additionalArgs = this.appendTerraformVariables(additionalArgs);

        const applyCommand = this.createAuthCommand("apply", additionalArgs);
        const terraformTool = this.terraformToolHandler.createToolRunner(applyCommand);
        await this.handleProvider(applyCommand);
        await this.warnIfMultipleProviders();

        return terraformTool.execAsync(<IExecOptions>{
            cwd: applyCommand.workingDirectory
        });
    }

    public async destroy(): Promise<number> {
        let additionalArgs = this.ensureAutoApprove(tasks.getInput("commandOptions"));
        additionalArgs = this.appendParallelism(additionalArgs);
        additionalArgs = await this.appendSecureVarFile(additionalArgs);
        additionalArgs = this.appendTerraformVariables(additionalArgs);

        const destroyCommand = this.createAuthCommand("destroy", additionalArgs);
        const terraformTool = this.terraformToolHandler.createToolRunner(destroyCommand);
        await this.handleProvider(destroyCommand);
        await this.warnIfMultipleProviders();

        return terraformTool.execAsync(<IExecOptions>{
            cwd: destroyCommand.workingDirectory
        });
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

        const testCommand = this.createAuthCommand("test", commandOptions);
        const terraformTool = this.terraformToolHandler.createToolRunner(testCommand);
        await this.handleProvider(testCommand);
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
        const commandOptions = tasks.getInput("commandOptions");

        let args = commandOptions
            ? `${commandOptions} ${resourceAddress} ${resourceId}`
            : `${resourceAddress} ${resourceId}`;
        args = await this.appendSecureVarFile(args);
        args = this.appendTerraformVariables(args);

        const importCommand = this.createAuthCommand("import", args);
        const terraformTool = this.terraformToolHandler.createToolRunner(importCommand);
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
        } catch {
            // Not valid JSON plan or unexpected structure — skip silently
        }
    }
}
