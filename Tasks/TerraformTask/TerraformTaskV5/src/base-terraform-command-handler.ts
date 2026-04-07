import { TerraformToolHandler, ITerraformToolHandler } from './terraform';
import { ToolRunner, IExecOptions, IExecSyncOptions } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformBaseCommandInitializer, TerraformAuthorizationCommandInitializer } from './terraform-commands';
import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { v4 as uuidV4 } from 'uuid';
import fs = require('fs');

export abstract class BaseTerraformCommandHandler {
    providerName: string;
    terraformToolHandler: ITerraformToolHandler;
    backendConfig: Map<string, string>;
    protected tempFiles: string[];

    abstract handleBackend(terraformToolRunner: ToolRunner): Promise<void>;
    abstract handleProvider(command: TerraformAuthorizationCommandInitializer): Promise<void>;

    constructor() {
        this.providerName = "";
        this.terraformToolHandler = new TerraformToolHandler(tasks);
        this.backendConfig = new Map<string, string>();
        this.tempFiles = [];
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
    }

    public warnIfMultipleProviders(): void {
        let terraformPath;
        try {
            terraformPath = tasks.which("terraform", true);
        } catch {
            throw new Error(tasks.loc("TerraformToolNotFound"));
        }

        const terraformToolRunner: ToolRunner = tasks.tool(terraformPath);
        terraformToolRunner.arg("providers");
        const commandOutput = terraformToolRunner.execSync(<IExecSyncOptions>{
            cwd: tasks.getInput("workingDirectory") || ''
        });

        const countProviders = ["aws", "azurerm", "google", "oracle"].filter(provider => commandOutput.stdout.includes(provider)).length;

        tasks.debug(countProviders.toString());
        if (countProviders > 1) {
            tasks.warning("Multiple provider blocks specified in the .tf files in the current working directory.");
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
        };
        const fn = commands[command];
        if (!fn) {
            throw new Error(`Invalid command: ${command}. Valid: ${Object.keys(commands).join(', ')}`);
        }
        return fn();
    }

    public async init(): Promise<number> {
        const initCommand = new TerraformBaseCommandInitializer(
            "init",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput("commandOptions")
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(initCommand);
        await this.handleBackend(terraformTool);

        return await terraformTool.execAsync(<IExecOptions>{
            cwd: initCommand.workingDirectory
        });
    }
    public async show(): Promise<number> {
        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        let cmd;
        const outputTo = tasks.getInput("outputTo");
        const outputFormat = tasks.getInput("outputFormat");
        if (outputFormat === "json") {
            cmd = tasks.getInput("commandOptions") ? `-json  ${tasks.getInput("commandOptions")}` : `-json`;
        } else {
            cmd = tasks.getInput("commandOptions") ? tasks.getInput("commandOptions") : ``;
        }

        const showCommand = new TerraformAuthorizationCommandInitializer(
            "show",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            cmd
        );
        const terraformTool = this.terraformToolHandler.createToolRunner(showCommand);
        await this.handleProvider(showCommand);

        if (outputTo === "console") {
            return await terraformTool.execAsync(<IExecOptions>{
                cwd: showCommand.workingDirectory
            });
        } else if (outputTo === "file") {
            const showFilePath = path.resolve(showCommand.workingDirectory, tasks.getInput("filename") || '');
            const commandOutput = await terraformTool.execSync(<IExecSyncOptions>{
                cwd: showCommand.workingDirectory,
            });

            tasks.writeFile(showFilePath, commandOutput.stdout);
            tasks.setVariable('showFilePath', showFilePath, false, true);

            return commandOutput.code;
        }
        throw new Error("Invalid outputTo value. Must be 'console' or 'file'.");
    }
    public async output(): Promise<number> {
        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        const commandOptions = tasks.getInput("commandOptions") ? `-json ${tasks.getInput("commandOptions")}` : `-json`

        const outputCommand = new TerraformAuthorizationCommandInitializer(
            "output",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            commandOptions
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(outputCommand);
        await this.handleProvider(outputCommand);

        const jsonOutputVariablesFilePath = path.resolve(outputCommand.workingDirectory, `output-${uuidV4()}.json`);
        const commandOutput = await terraformTool.execSync(<IExecSyncOptions>{
            cwd: outputCommand.workingDirectory,
        });

        tasks.writeFile(jsonOutputVariablesFilePath, commandOutput.stdout);
        tasks.setVariable('jsonOutputVariablesPath', jsonOutputVariablesFilePath, false, true);

        return commandOutput.code;
    }

    public async plan(): Promise<number> {
        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        let commandOptions = tasks.getInput("commandOptions") ? `${tasks.getInput("commandOptions")} -detailed-exitcode` : `-detailed-exitcode`
        const replaceAddress = tasks.getInput("replaceAddress", false);
        if (replaceAddress) {
            commandOptions = `-replace=${replaceAddress} ${commandOptions}`;
        }
        const planCommand = new TerraformAuthorizationCommandInitializer(
            "plan",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            commandOptions
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(planCommand);
        await this.handleProvider(planCommand);
        this.warnIfMultipleProviders();

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
        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        const customCommand = new TerraformAuthorizationCommandInitializer(
            tasks.getInput("customCommand", true)!,
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            tasks.getInput("commandOptions")
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(customCommand);
        await this.handleProvider(customCommand);

        if (outputTo === "console") {
            return await terraformTool.execAsync(<IExecOptions>{
                cwd: customCommand.workingDirectory
            });
        } else if (outputTo === "file") {
            const customFilePath = path.resolve(customCommand.workingDirectory, tasks.getInput("filename") || '');
            const commandOutput = await terraformTool.execSync(<IExecSyncOptions>{
                cwd: customCommand.workingDirectory
            });

            tasks.writeFile(customFilePath, commandOutput.stdout);
            tasks.setVariable('customFilePath', customFilePath, false, true);
            return commandOutput.code;
        }
        throw new Error("Invalid outputTo value. Must be 'console' or 'file'.");
    }

    public async apply(): Promise<number> {
        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        const autoApprove: string = '-auto-approve';
        let additionalArgs: string = tasks.getInput("commandOptions") || autoApprove;

        if (additionalArgs.includes(autoApprove) === false) {
            additionalArgs = `${autoApprove} ${additionalArgs}`;
        }
        const replaceAddress = tasks.getInput("replaceAddress", false);
        if (replaceAddress) {
            additionalArgs = `-replace=${replaceAddress} ${additionalArgs}`;
        }

        const applyCommand = new TerraformAuthorizationCommandInitializer(
            "apply",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            additionalArgs
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(applyCommand);
        await this.handleProvider(applyCommand);
        this.warnIfMultipleProviders();

        return await terraformTool.execAsync(<IExecOptions>{
            cwd: applyCommand.workingDirectory
        });
    }

    public async destroy(): Promise<number> {

        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        const autoApprove: string = '-auto-approve';
        let additionalArgs: string = tasks.getInput("commandOptions") || autoApprove;

        if (additionalArgs.includes(autoApprove) === false) {
            additionalArgs = `${autoApprove} ${additionalArgs}`;
        }

        const destroyCommand = new TerraformAuthorizationCommandInitializer(
            "destroy",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            additionalArgs
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(destroyCommand);
        await this.handleProvider(destroyCommand);
        this.warnIfMultipleProviders();

        return await terraformTool.execAsync(<IExecOptions>{
            cwd: destroyCommand.workingDirectory
        });
    }

    public async validate(): Promise<number> {
        const validateCommand = new TerraformBaseCommandInitializer(
            "validate",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput("commandOptions")
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(validateCommand);

        return await terraformTool.execAsync(<IExecOptions>{
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

        const workspaceCommand = new TerraformBaseCommandInitializer(
            `workspace ${subCommand}`,
            tasks.getInput("workingDirectory") || '',
            additionalArgs
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(workspaceCommand);
        return await terraformTool.execAsync(<IExecOptions>{
            cwd: workspaceCommand.workingDirectory
        });
    }

    public async state(): Promise<number> {
        const subCommand = tasks.getInput("stateSubCommand", true)!;
        const stateAddress = tasks.getInput("stateAddress", false);

        if (subCommand === 'push') {
            tasks.warning("terraform state push is a potentially destructive operation. Ensure you have a current backup of your state file.");
        }

        const stateCommand = new TerraformBaseCommandInitializer(
            `state ${subCommand}`,
            tasks.getInput("workingDirectory") || '',
            stateAddress || tasks.getInput("commandOptions") || undefined
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(stateCommand);
        return await terraformTool.execAsync(<IExecOptions>{
            cwd: stateCommand.workingDirectory
        });
    }

    public async fmt(): Promise<number> {
        let args = "";
        if (tasks.getBoolInput("fmtCheck", false)) { args += " -check"; }
        if (tasks.getBoolInput("fmtRecursive", false)) { args += " -recursive"; }
        const commandOptions = tasks.getInput("commandOptions");
        if (commandOptions) { args += ` ${commandOptions}`; }

        const fmtCommand = new TerraformBaseCommandInitializer(
            "fmt",
            tasks.getInput("workingDirectory") || '',
            args.trim() || undefined
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(fmtCommand);
        return await terraformTool.execAsync(<IExecOptions>{
            cwd: fmtCommand.workingDirectory
        });
    }

    public async test(): Promise<number> {
        const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
        const testCommand = new TerraformAuthorizationCommandInitializer(
            "test",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput(serviceName, true)!,
            tasks.getInput("commandOptions")
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(testCommand);
        await this.handleProvider(testCommand);
        return await terraformTool.execAsync(<IExecOptions>{
            cwd: testCommand.workingDirectory
        });
    }

    public async get(): Promise<number> {
        const getCommand = new TerraformBaseCommandInitializer(
            "get",
            tasks.getInput("workingDirectory") || '',
            tasks.getInput("commandOptions")
        );

        const terraformTool = this.terraformToolHandler.createToolRunner(getCommand);
        return await terraformTool.execAsync(<IExecOptions>{
            cwd: getCommand.workingDirectory
        });
    }
}
