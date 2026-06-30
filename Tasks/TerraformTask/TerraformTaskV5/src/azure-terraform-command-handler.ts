import tasks = require("azure-pipelines-task-lib/task");
import { ToolRunner, IExecOptions } from "azure-pipelines-task-lib/toolrunner";
import { TerraformAuthorizationCommandInitializer } from "./terraform-commands";
import { BaseTerraformCommandHandler } from "./base-terraform-command-handler";
import { EnvironmentVariableHelper } from "./environment-variables";
import { generateIdToken } from './id-token-generator';

/**
 * Reads the user-assigned managed identity's client ID from an MSI-scheme
 * service connection, if the connection carries one. Returns undefined for a
 * system-assigned identity (the connection's "Service Principal Id" field is
 * left blank), which preserves the existing system-assigned-only behavior.
 */
export function getManagedIdentityClientId(serviceConnectionID: string): string | undefined {
    // getEndpointAuthorizationParameter's 3rd param is named `optional` (true =
    // don't throw when absent) - the opposite convention from getInput's
    // `required`. true here is what makes this genuinely optional.
    return tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalid", true) || undefined;
}

export class TerraformCommandHandlerAzureRM extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "azurerm";
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const serviceConnectionID = tasks.getInput("backendServiceArm", true)!;
        const authorizationScheme = this.mapAuthorizationScheme(tasks.getEndpointAuthorizationScheme(serviceConnectionID, true)!);

        tasks.debug("Setting up backend for authorization scheme: " + authorizationScheme + ".");

        // Setup required backend configuration for storage account blob location
        this.backendConfig.set("storage_account_name", tasks.getInput("backendAzureRmStorageAccountName", true)!);
        this.backendConfig.set("container_name", tasks.getInput("backendAzureRmContainerName", true)!);
        this.backendConfig.set("key", tasks.getInput("backendAzureRmKey", true)!);

        // Setup the optional backend configuration for the storage account blob location with subscription ID and resource group name (set as backend config to ensure it is cached)
        const resourceGroupName = tasks.getInput("backendAzureRmResourceGroupName", false);
        if (resourceGroupName) {
            this.backendConfig.set("resource_group_name", resourceGroupName);
        }

        let subscriptionId = tasks.getInput("backendAzureRmOverrideSubscriptionID", false);
        if (!subscriptionId) {
            subscriptionId = tasks.getEndpointDataParameter(serviceConnectionID, "subscriptionid", true);
        }
        if (subscriptionId && resourceGroupName) {
            this.backendConfig.set("subscription_id", subscriptionId);
        }

        // Setup Entra ID authentication (set as backend config to ensure it is cached)
        const useEntraIdAuthentication = tasks.getBoolInput("backendAzureRmUseEntraIdForAuthentication", false);
        if (useEntraIdAuthentication) {
            this.backendConfig.set("use_azuread_auth", "true");
        }

        const fallbackToIdTokenGeneration = tasks.getBoolInput("backendAzureRmUseIdTokenGeneration", false);
        const backendAzureRmUseCliFlagsForAuthentication = tasks.getBoolInput("backendAzureRmUseCliFlagsForAuthentication", false);

        await this.setCommonVariables(authorizationScheme, serviceConnectionID, fallbackToIdTokenGeneration, backendAzureRmUseCliFlagsForAuthentication);

        this.applyBackendConfig(terraformToolRunner);

        tasks.debug("Finished setting up backend for authorization scheme: " + authorizationScheme + ".");
    }

    public async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const serviceConnectionID = tasks.getInput("environmentServiceNameAzureRM", true)!;
        const authorizationScheme = this.mapAuthorizationScheme(tasks.getEndpointAuthorizationScheme(serviceConnectionID, true)!);

        tasks.debug("Setting up provider for authorization scheme: " + authorizationScheme + ".");

        // Setup required provider configuration for subscription ID
        let subscriptionId = tasks.getInput("environmentAzureRmOverrideSubscriptionID", false);
        if (!subscriptionId) {
            subscriptionId = tasks.getEndpointDataParameter(serviceConnectionID, "subscriptionid", true);
        }
        if (subscriptionId) {
            EnvironmentVariableHelper.setEnvironmentVariable("ARM_SUBSCRIPTION_ID", subscriptionId);
        }

        const fallbackToIdTokenGeneration = tasks.getBoolInput("environmentAzureRmUseIdTokenGeneration", false);

        await this.setCommonVariables(authorizationScheme, serviceConnectionID, fallbackToIdTokenGeneration, false);

        // Optionally run az login for local-exec provisioners and external data sources
        if (tasks.getBoolInput("runAzLogin", false)) {
            await this.runAzLogin(authorizationScheme, serviceConnectionID, subscriptionId || '');
        }

        tasks.debug("Finished up provider for authorization scheme: " + authorizationScheme + ".");
    }

    // ACCEPTED RESIDUAL: --federated-token and --password below put the WIF token /
    // service-principal secret on this process's argv, visible to any other process
    // on the agent via ps / /proc/<pid>/cmdline for az login's short lifetime. az CLI
    // has no file/stdin/env alternative for these specific flags - every documented
    // usage pattern (including Microsoft's own "$env:AZURE_FEDERATED_TOKEN" examples)
    // still substitutes the value into a literal argv string before az sees it; the
    // env var only sources where the value comes FROM, not how az receives it. This
    // is bounded: runAzLogin is opt-in (default false, only for local-exec/external
    // data sources), and the primary terraform-provider auth path never touches argv -
    // it sets ARM_CLIENT_SECRET/ARM_OIDC_TOKEN/etc. as environment variables exclusively
    // (see setCommonVariables). Residual risk concentrates on shared self-hosted agents;
    // ManagedServiceIdentity's `az login --identity` carries no secret in argv at all.
    private async runAzLogin(authorizationScheme: AuthorizationScheme, serviceConnectionID: string, subscriptionId: string): Promise<void> {
        tasks.debug("Running az login for local-exec / external data source support.");

        let azPath: string;
        try {
            azPath = tasks.which("az", true);
        } catch {
            throw new Error("az CLI not found. Install the Azure CLI on the agent to use 'Run az login'. See https://docs.microsoft.com/cli/azure/install-azure-cli");
        }

        const tenantId = tasks.getEndpointAuthorizationParameter(serviceConnectionID, "tenantid", true)!;

        switch (authorizationScheme) {
            case AuthorizationScheme.WorkloadIdentityFederation: {
                const spnId = tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalid", true)!;
                const oidcToken = await generateIdToken(serviceConnectionID);
                tasks.setSecret(oidcToken);

                const loginTool: ToolRunner = tasks.tool(azPath);
                loginTool.arg(["login", "--service-principal",
                    "--username", spnId,
                    "--tenant", tenantId,
                    "--allow-no-subscriptions",
                    "--federated-token", oidcToken]);

                const loginResult = await loginTool.execAsync(<IExecOptions>{ silent: true });
                if (loginResult !== 0) {
                    throw new Error(`az login failed with exit code ${loginResult}`);
                }
                break;
            }
            case AuthorizationScheme.ServicePrincipal: {
                const spnId = tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalid", true)!;
                const spnKey = tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalkey", true)!;
                if (spnKey) { tasks.setSecret(spnKey); }

                const loginTool: ToolRunner = tasks.tool(azPath);
                loginTool.arg(["login", "--service-principal",
                    "--username", spnId,
                    "--password", spnKey,
                    "--tenant", tenantId,
                    "--allow-no-subscriptions"]);

                const loginResult = await loginTool.execAsync(<IExecOptions>{ silent: true });
                if (loginResult !== 0) {
                    throw new Error(`az login failed with exit code ${loginResult}`);
                }
                break;
            }
            case AuthorizationScheme.ManagedServiceIdentity: {
                const loginTool: ToolRunner = tasks.tool(azPath);
                const loginArgs = ["login", "--identity"];
                // A user-assigned identity's client ID, when the connection carries one
                // (see the matching comment in setCommonVariables) - omitted falls back
                // to the agent's system-assigned identity, unchanged from before.
                const msiClientId = getManagedIdentityClientId(serviceConnectionID);
                if (msiClientId) {
                    loginArgs.push("--username", msiClientId);
                }
                loginTool.arg(loginArgs);

                const loginResult = await loginTool.execAsync(<IExecOptions>{ silent: true });
                if (loginResult !== 0) {
                    throw new Error(`az login failed with exit code ${loginResult}`);
                }
                break;
            }
        }

        if (subscriptionId) {
            const setTool: ToolRunner = tasks.tool(azPath);
            setTool.arg(["account", "set", "--subscription", subscriptionId]);
            await setTool.execAsync(<IExecOptions>{ silent: true });
        }

        tasks.debug("az login completed successfully.");
    }

    private async setCommonVariables(authorizationScheme: AuthorizationScheme, serviceConnectionID: string, fallbackToIdTokenGeneration: boolean, useCliFlagsForBackend: boolean): Promise<void> {
        EnvironmentVariableHelper.setEnvironmentVariable("ARM_TENANT_ID", tasks.getEndpointAuthorizationParameter(serviceConnectionID, "tenantid", false) ?? '');

        switch (authorizationScheme) {
            case AuthorizationScheme.ManagedServiceIdentity: {
                EnvironmentVariableHelper.setEnvironmentVariable("ARM_USE_MSI", "true");
                // ARM_USE_MSI alone authenticates as the agent's system-assigned identity.
                // If the connection targets a user-assigned identity instead, the azurerm
                // provider needs ARM_CLIENT_ID to disambiguate which identity to use - the
                // connection's "Service Principal Id" field carries that client ID for an
                // MSI-scheme connection (same endpoint parameter the WorkloadIdentityFederation
                // and ServicePrincipal schemes already read below). Optional: omitted falls
                // back to system-assigned MSI, unchanged from before.
                const msiClientId = getManagedIdentityClientId(serviceConnectionID);
                if (msiClientId) {
                    EnvironmentVariableHelper.setEnvironmentVariable("ARM_CLIENT_ID", msiClientId);
                }
                break;
            }

            case AuthorizationScheme.WorkloadIdentityFederation: {
                const workloadIdentityFederationCredentials = await this.getWorkloadIdentityFederationCredentials(serviceConnectionID, fallbackToIdTokenGeneration);
                if (useCliFlagsForBackend) {
                    // By persisting the client ID in the backend config, we can support multiple service connections for backend and provider auth.
                    this.backendConfig.set("client_id", workloadIdentityFederationCredentials.servicePrincipalId);
                    this.backendConfig.set("use_oidc", "true");
                } else {
                    EnvironmentVariableHelper.setEnvironmentVariable("ARM_CLIENT_ID", workloadIdentityFederationCredentials.servicePrincipalId);
                    EnvironmentVariableHelper.setEnvironmentVariable("ARM_USE_OIDC", "true");
                }

                if (fallbackToIdTokenGeneration) {
                    tasks.debug("ID token generation fallback is enabled, generating ID Token.");
                    EnvironmentVariableHelper.setEnvironmentVariable("ARM_OIDC_TOKEN", workloadIdentityFederationCredentials.oidcToken, true);
                } else {
                    tasks.debug("ID token generation fallback is disabled, using ID Token Refresh.");
                    if (useCliFlagsForBackend) {
                        // By persisting the service connection ID in the backend config, we can support multiple service connections for backend and provider auth.
                        this.backendConfig.set("ado_pipeline_service_connection_id", serviceConnectionID);
                    } else {
                        EnvironmentVariableHelper.setEnvironmentVariable("ARM_OIDC_AZURE_SERVICE_CONNECTION_ID", serviceConnectionID);
                    }
                    const accessToken = tasks.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
                    if (!accessToken) {
                        throw new Error("AccessToken not found in SystemVssConnection. Ensure the pipeline has OIDC enabled.");
                    }
                    tasks.setSecret(accessToken);
                    EnvironmentVariableHelper.setEnvironmentVariable("ARM_OIDC_REQUEST_TOKEN", accessToken, true);
                }

                break;
            }

            case AuthorizationScheme.ServicePrincipal: {
                tasks.warning("Client secret authentication is not secure and will be deprecated in the next major version of this task. Please use Workload identity federation authentication instead.");

                const servicePrincipalCredentials = this.getServicePrincipalCredentials(serviceConnectionID);
                if (servicePrincipalCredentials.servicePrincipalKey) { tasks.setSecret(servicePrincipalCredentials.servicePrincipalKey); }
                EnvironmentVariableHelper.setEnvironmentVariable("ARM_CLIENT_ID", servicePrincipalCredentials.servicePrincipalId);
                EnvironmentVariableHelper.setEnvironmentVariable("ARM_CLIENT_SECRET", servicePrincipalCredentials.servicePrincipalKey, true);
                break;
            }
        }
    }

    private getServicePrincipalCredentials(serviceConnectionID: string): ServicePrincipalCredentials {
        const servicePrincipalCredentials: ServicePrincipalCredentials = {
            servicePrincipalId: tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalid", true)!,
            servicePrincipalKey: tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalkey", true)!
        }
        return servicePrincipalCredentials;
    }

    private async getWorkloadIdentityFederationCredentials(serviceConnectionID: string, getIdToken: boolean): Promise<WorkloadIdentityFederationCredentials> {
        const workloadIdentityFederationCredentials: WorkloadIdentityFederationCredentials = {
            servicePrincipalId: tasks.getEndpointAuthorizationParameter(serviceConnectionID, "serviceprincipalid", true)!,
            oidcToken: ""
        }
        if (getIdToken) {
            workloadIdentityFederationCredentials.oidcToken = await generateIdToken(serviceConnectionID);
        }
        return workloadIdentityFederationCredentials;
    }

    private mapAuthorizationScheme(authorizationScheme: string): AuthorizationScheme {
        if (authorizationScheme === undefined) {
            tasks.warning("The authorization scheme could not be found for your Service Connection, using Workload identity federation by default, but this could cause issues.");
            return AuthorizationScheme.WorkloadIdentityFederation;
        }

        if (authorizationScheme.toLowerCase() === AuthorizationScheme.ServicePrincipal) {
            return AuthorizationScheme.ServicePrincipal;
        }

        if (authorizationScheme.toLowerCase() === AuthorizationScheme.ManagedServiceIdentity) {
            return AuthorizationScheme.ManagedServiceIdentity;
        }

        if (authorizationScheme.toLowerCase() === AuthorizationScheme.WorkloadIdentityFederation) {
            return AuthorizationScheme.WorkloadIdentityFederation;
        }

        throw new Error(`Unrecognized authorization scheme '${authorizationScheme}'. Supported schemes: WorkloadIdentityFederation, ManagedServiceIdentity, ServicePrincipal.`);
    }
}

interface ServicePrincipalCredentials {
    servicePrincipalId: string;
    servicePrincipalKey: string;
}

interface WorkloadIdentityFederationCredentials {
    servicePrincipalId: string;
    oidcToken: string;
}

enum AuthorizationScheme {
    ServicePrincipal = "serviceprincipal",
    ManagedServiceIdentity = "managedserviceidentity",
    WorkloadIdentityFederation = "workloadidentityfederation"
}
