import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';

export class TerraformCommandHandlerHCP extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "hcp";
    }

    public async handleBackend(_terraformToolRunner: ToolRunner): Promise<void> {
        const token = tasks.getInput("backendHCPToken", true)!;
        if (token) { tasks.setSecret(token); }
        EnvironmentVariableHelper.setEnvironmentVariable("TF_TOKEN_app_terraform_io", token, true);

        const organization = tasks.getInput("backendHCPOrganization", false);
        if (organization && organization.trim()) {
            EnvironmentVariableHelper.setEnvironmentVariable("TF_CLOUD_ORGANIZATION", organization.trim());
        }

        const workspace = tasks.getInput("backendHCPWorkspace", false);
        if (workspace && workspace.trim()) {
            EnvironmentVariableHelper.setEnvironmentVariable("TF_WORKSPACE", workspace.trim());
        }
    }

    public async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> {
        // No-op: HCP backend does not provide cloud provider credentials for plan/apply
    }
}
