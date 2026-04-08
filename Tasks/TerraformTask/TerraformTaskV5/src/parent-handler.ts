import tasks = require('azure-pipelines-task-lib/task');
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { TerraformCommandHandlerAzureRM } from './azure-terraform-command-handler';
import { TerraformCommandHandlerAWS } from './aws-terraform-command-handler';
import { TerraformCommandHandlerGCP } from './gcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from './oci-terraform-command-handler';
import { TerraformCommandHandlerGeneric } from './generic-terraform-command-handler';
import { TerraformCommandHandlerHCP } from './hcp-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';

export interface IParentCommandHandler {
    execute(providerName: string, command: string): Promise<number>;
    emergencyCleanup(): void;
}

export class ParentCommandHandler implements IParentCommandHandler {
    private activeHandler: BaseTerraformCommandHandler | null = null;

    public async execute(providerName: string, command: string): Promise<number> {
        let handler: BaseTerraformCommandHandler;

        if (command === 'init') {
            // For init: backendType drives handler selection (falls back to providerName for backwards compat)
            const backendType = tasks.getInput("backendType", false) || providerName;
            handler = this.createHandler(backendType);
        } else {
            // For all other commands: provider drives handler selection
            handler = this.createHandler(providerName);
        }

        this.activeHandler = handler;
        try {
            return await handler.executeCommand(command);
        } finally {
            handler.cleanupTempFiles();
            EnvironmentVariableHelper.clearTrackedVariables();
            this.activeHandler = null;
        }
    }

    public emergencyCleanup(): void {
        if (this.activeHandler) {
            this.activeHandler.cleanupTempFiles();
            EnvironmentVariableHelper.clearTrackedVariables();
        }
    }

    private createHandler(name: string): BaseTerraformCommandHandler {
        switch (name) {
            case "azurerm": return new TerraformCommandHandlerAzureRM();
            case "aws":     // provider name fallback
            case "s3": return new TerraformCommandHandlerAWS();
            case "gcp":     // provider name fallback
            case "gcs": return new TerraformCommandHandlerGCP();
            case "oci": return new TerraformCommandHandlerOCI();
            case "hcp": return new TerraformCommandHandlerHCP();
            case "generic":
            case "local": return new TerraformCommandHandlerGeneric();
            default: throw new Error(`Unknown backend/provider type: ${name}`);
        }
    }
}
