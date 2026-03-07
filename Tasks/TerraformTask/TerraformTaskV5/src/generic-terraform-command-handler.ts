import tasks = require('azure-pipelines-task-lib/task');
import {ToolRunner} from 'azure-pipelines-task-lib/toolrunner';
import {TerraformAuthorizationCommandInitializer} from './terraform-commands';
import {BaseTerraformCommandHandler} from './base-terraform-command-handler';

export class TerraformCommandHandlerGeneric extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "generic";
    }

    public async handleBackend(terraformToolRunner: ToolRunner) : Promise<void> {
        const configFile = tasks.getInput("backendConfigFile", false);
        if (configFile && configFile.trim()) {
            terraformToolRunner.arg(`-backend-config=${configFile.trim()}`);
        }

        const configArgs = tasks.getInput("backendConfigArgs", false);
        if (configArgs) {
            for (const line of configArgs.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    terraformToolRunner.arg(`-backend-config=${trimmed}`);
                }
            }
        }
    }

    public async handleProvider(command: TerraformAuthorizationCommandInitializer) : Promise<void> {
        // No provider credentials needed for generic/local backend type
    }
}
