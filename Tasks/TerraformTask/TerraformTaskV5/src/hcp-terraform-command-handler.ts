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

    /** Shared by `handleBackend` (init) and `configureBackendCredentials` (cross-cloud). */
    private applyBackendEnv(): void {
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

    public async handleBackend(_terraformToolRunner: ToolRunner): Promise<void> {
        this.applyBackendEnv();
    }

    /**
     * Cross-cloud path: called instead of `handleBackend` on state-accessing
     * commands (plan/apply/...) when this HCP Terraform/Terraform Cloud
     * backend is paired with a *different* cloud's `provider` input. Sets the
     * same TF_TOKEN_app_terraform_io/TF_CLOUD_ORGANIZATION/TF_WORKSPACE
     * environment variables as init.
     */
    public async configureBackendCredentials(): Promise<void> {
        tasks.debug("Configuring cross-cloud HCP backend credentials (environment variables only).");
        this.applyBackendEnv();
    }

    public async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> {
        // No-op: HCP backend does not provide cloud provider credentials for plan/apply
    }
}
