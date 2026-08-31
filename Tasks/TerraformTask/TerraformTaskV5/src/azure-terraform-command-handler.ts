import tasks = require("azure-pipelines-task-lib/task");
import { ToolRunner, IExecOptions } from "azure-pipelines-task-lib/toolrunner";
import { TerraformAuthorizationCommandInitializer } from "./terraform-commands";
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { EnvironmentVariableHelper } from "@4cloudguru/pipeline-task-ado";
import { generateIdToken } from '@4cloudguru/pipeline-task-ado';
import {
    assertIdentityValue,
    neutralizeEnvironmentVariables,
    requireIdentityField,
    requireSecretField,
    resolveOidcRequestUrl,
} from './credential-guards';

/**
 * The `ARM_*` variables that make the azurerm provider choose a particular
 * credential. Each auth branch clears the ones belonging to the schemes it is
 * NOT using, so a value inherited from a self-hosted agent or an earlier task
 * cannot decide the run's identity (#187). `ARM_USE_MSI` in particular only
 * reaches the agent identity while the secret/OIDC/certificate variables are
 * absent.
 */
const ARM_IDENTITY_SELECTORS = {
    secret: 'ARM_CLIENT_SECRET',
    oidcToken: 'ARM_OIDC_TOKEN',
    certPath: 'ARM_CLIENT_CERTIFICATE_PATH',
    cert: 'ARM_CLIENT_CERTIFICATE',
    useMsi: 'ARM_USE_MSI',
    useOidc: 'ARM_USE_OIDC',
} as const;

/**
 * Every ARM_* variable that can decide WHICH identity the azurerm provider
 * authenticates as. Cleared wholesale at the top of `setCommonVariables`, before
 * the scheme branch re-establishes exactly the ones it needs.
 * ARM_SUBSCRIPTION_ID is not here: it names a target, not an identity, and is
 * resolved and set by the caller before `setCommonVariables` runs.
 */
const ARM_CREDENTIAL_SELECTOR_ENV = [
    'ARM_CLIENT_ID',
    'ARM_CLIENT_SECRET',
    'ARM_CLIENT_CERTIFICATE',
    'ARM_CLIENT_CERTIFICATE_PATH',
    'ARM_CLIENT_CERTIFICATE_PASSWORD',
    'ARM_OIDC_TOKEN',
    'ARM_OIDC_TOKEN_FILE_PATH',
    'ARM_OIDC_REQUEST_TOKEN',
    'ARM_OIDC_REQUEST_URL',
    'ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID',
    'ARM_OIDC_AZURE_SERVICE_CONNECTION_ID',
    'ARM_USE_MSI',
    'ARM_USE_OIDC',
    // azurerm's enableOidc = use_oidc || use_aks_workload_identity (#1026): this
    // flag re-enables OIDC on its own even with ARM_USE_OIDC absent.
    'ARM_USE_AKS_WORKLOAD_IDENTITY',
    'ARM_USE_CLI',
    'ARM_TENANT_ID',
] as const;

/**
 * Wall-clock bound for `az login`/`az account set` (#822, CWE-1088) -- ALWAYS
 * ON, independent of the opt-in `commandTimeoutMinutes` input, because these
 * are fast auxiliary calls (themselves opt-in via `runAzLogin`, for
 * local-exec provisioners/external data sources) with no user-facing timeout
 * knob of their own. Before this fix, a hung `az login --identity` against an
 * unreachable instance-metadata endpoint (managed identity) blocked the job
 * indefinitely with no task-level diagnostic at all -- not even opt-in, unlike
 * the main terraform command path. 2 minutes comfortably covers a slow but
 * healthy login/account-set while still failing fast on a genuine hang.
 */
export const AZ_LOGIN_TIMEOUT_MINUTES = 2;
export const AZ_LOGIN_TIMEOUT_MS = AZ_LOGIN_TIMEOUT_MINUTES * 60_000;

/**
 * Reads the user-assigned managed identity's client ID from an MSI-scheme
 * service connection, if the connection carries one. Returns undefined for a
 * system-assigned identity (the connection's "Service Principal Id" field is
 * left blank), which preserves the existing system-assigned-only behavior.
 */
export function getManagedIdentityClientId(serviceConnectionID: string): string | undefined {
    // @credential-exempt: this read is optional BY DESIGN and is the one place in
    // the matrix where absence is the correct, secure outcome. An MSI-scheme
    // connection leaves "Service Principal Id" blank for a SYSTEM-assigned
    // identity; returning undefined then means "use the agent's own identity",
    // which is precisely the principal that scheme selects. Making it required
    // would break every system-assigned connection. The caller's MSI branch
    // clears ARM_CLIENT_ID when this returns undefined, so an inherited value
    // cannot substitute a user-assigned identity nobody configured.
    //
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

    /**
     * Resolves the backend service connection's auth scheme and sets the
     * shared ARM_* credential environment variables (tenant, and whichever of
     * client-id/secret/OIDC-token/MSI the scheme needs), plus ARM_SUBSCRIPTION_ID
     * when resolvable. Shared by `handleBackend` (init, where
     * `useCliFlagsForBackend` may route some values into cached backend-config
     * instead) and `configureBackendCredentials` (every later state-accessing
     * command, which always passes `false` — cross-cloud injection is env-only,
     * per HashiCorp's guidance against caching backend credentials on disk).
     */
    private async applyBackendCredentialEnv(serviceConnectionID: string, useCliFlagsForBackend: boolean, isTerminalCredentialPass: boolean): Promise<AuthorizationScheme> {
        const authorizationScheme = this.mapAuthorizationScheme(tasks.getEndpointAuthorizationScheme(serviceConnectionID, true), serviceConnectionID);

        let subscriptionId = tasks.getInput("backendAzureRmOverrideSubscriptionID", false);
        if (!subscriptionId) {
            subscriptionId = tasks.getEndpointDataParameter(serviceConnectionID, "subscriptionid", true);
        }
        if (subscriptionId) {
            subscriptionId = assertIdentityValue(subscriptionId, `Azure subscription id for service connection '${serviceConnectionID}'`);
            EnvironmentVariableHelper.setEnvironmentVariable("ARM_SUBSCRIPTION_ID", subscriptionId);
        } else {
            // Nothing resolved from the input or the connection: an inherited
            // ARM_SUBSCRIPTION_ID would otherwise silently target a subscription
            // this service connection never named (#187).
            neutralizeEnvironmentVariables(['ARM_SUBSCRIPTION_ID'], "Azure");
        }

        const fallbackToIdTokenGeneration = tasks.getBoolInput("backendAzureRmUseIdTokenGeneration", false);
        await this.setCommonVariables(authorizationScheme, serviceConnectionID, fallbackToIdTokenGeneration, useCliFlagsForBackend);

        // #1026: azurerm's OIDC config also has MultiEnvDefaultFunc fallbacks onto
        // ACTIONS_ID_TOKEN_REQUEST_TOKEN/URL, which in turn chain onto
        // SYSTEM_ACCESSTOKEN/SYSTEM_OIDCREQUESTURI -- names this task never sets
        // and so never appeared in ARM_CREDENTIAL_SELECTOR_ENV. The agent sets
        // SYSTEM_OIDCREQUESTURI on EVERY job regardless of authorization scheme.
        //
        // Only on the TERMINAL pass. `neutralizeEnvironmentVariables` deletes from
        // process.env, which is both the child's inherited environment AND this
        // task's own read surface -- so clearing here on the CROSS-CLOUD path
        // (configureBackendCredentials, which parent-handler runs BEFORE the
        // provider handler) would strip the endpoint out from under the provider's
        // own generateIdToken, which reads SYSTEM_OIDCREQUESTURI and fails closed
        // without it. That is the aws/gcp/oci-provider + azurerm-backend
        // combination, which no test covered.
        if (isTerminalCredentialPass) {
            neutralizeEnvironmentVariables(['SYSTEM_ACCESSTOKEN', 'SYSTEM_OIDCREQUESTURI'], "Azure");
        }

        return authorizationScheme;
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const serviceConnectionID = tasks.getInput("backendServiceArm", true)!;

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
            // Cached into .terraform/terraform.tfstate as a -backend-config value,
            // so it gets the same charset validation as every injected identity
            // field (#199).
            this.backendConfig.set("subscription_id",
                assertIdentityValue(subscriptionId, `Azure subscription id for service connection '${serviceConnectionID}'`));
        }

        // Setup Entra ID authentication (set as backend config to ensure it is cached)
        const useEntraIdAuthentication = tasks.getBoolInput("backendAzureRmUseEntraIdForAuthentication", false);
        if (useEntraIdAuthentication) {
            this.backendConfig.set("use_azuread_auth", "true");
        }

        const backendAzureRmUseCliFlagsForAuthentication = tasks.getBoolInput("backendAzureRmUseCliFlagsForAuthentication", false);

        tasks.debug("Setting up backend for authorization scheme.");
        const authorizationScheme = await this.applyBackendCredentialEnv(serviceConnectionID, backendAzureRmUseCliFlagsForAuthentication, /* isTerminalCredentialPass */ true);

        this.applyBackendConfig(terraformToolRunner);

        tasks.debug("Finished setting up backend for authorization scheme: " + authorizationScheme + ".");
    }

    /**
     * Cross-cloud path: called instead of `handleBackend` on state-accessing
     * commands (plan/apply/...) when this azurerm backend is paired with a
     * *different* cloud's `provider` input. Sets the same ARM_* credential
     * environment variables as init — never `-backend-config`, since that
     * would be silently ignored here anyway (this method never touches a tool
     * runner) and would only risk confusion. The non-secret location fields
     * (storage account, container, key, resource group, subscription,
     * use_azuread_auth) were already cached by `terraform init` and need not
     * be resupplied.
     */
    public async configureBackendCredentials(): Promise<void> {
        const serviceConnectionID = tasks.getInput("backendServiceArm", true)!;
        tasks.debug("Configuring cross-cloud azurerm backend credentials (environment variables only).");
        // Cross-cloud: parent-handler runs this BEFORE the provider handler, whose
        // own generateIdToken still needs the ambient OIDC names, so this pass is
        // not the terminal one.
        const authorizationScheme = await this.applyBackendCredentialEnv(serviceConnectionID, /* useCliFlagsForBackend */ false, /* isTerminalCredentialPass */ false);
        tasks.debug("Finished configuring cross-cloud azurerm backend credentials for authorization scheme: " + authorizationScheme + ".");
    }

    public async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> {
        const serviceConnectionID = tasks.getInput("environmentServiceNameAzureRM", true)!;
        const authorizationScheme = this.mapAuthorizationScheme(tasks.getEndpointAuthorizationScheme(serviceConnectionID, true), serviceConnectionID);

        tasks.debug("Setting up provider for authorization scheme: " + authorizationScheme + ".");

        // Setup required provider configuration for subscription ID
        let subscriptionId = tasks.getInput("environmentAzureRmOverrideSubscriptionID", false);
        if (!subscriptionId) {
            subscriptionId = tasks.getEndpointDataParameter(serviceConnectionID, "subscriptionid", true);
        }
        if (subscriptionId) {
            subscriptionId = assertIdentityValue(subscriptionId, `Azure subscription id for service connection '${serviceConnectionID}'`);
            EnvironmentVariableHelper.setEnvironmentVariable("ARM_SUBSCRIPTION_ID", subscriptionId);
        } else {
            // Nothing resolved from the input or the connection: an inherited
            // ARM_SUBSCRIPTION_ID would otherwise silently target a subscription
            // this service connection never named (#187).
            neutralizeEnvironmentVariables(['ARM_SUBSCRIPTION_ID'], "Azure");
        }

        const fallbackToIdTokenGeneration = tasks.getBoolInput("environmentAzureRmUseIdTokenGeneration", false);

        await this.setCommonVariables(authorizationScheme, serviceConnectionID, fallbackToIdTokenGeneration, false);

        // Optionally run az login for local-exec provisioners and external data sources
        if (tasks.getBoolInput("runAzLogin", false)) {
            await this.runAzLogin(authorizationScheme, serviceConnectionID, subscriptionId || '');
        }

        // #1026: cleared here, AFTER runAzLogin's OWN WorkloadIdentityFederation
        // branch (a SECOND, independent generateIdToken call for `az login
        // --federated-token`) -- clearing inside setCommonVariables would break
        // that second call, which runs after setCommonVariables has returned.
        neutralizeEnvironmentVariables(['SYSTEM_ACCESSTOKEN', 'SYSTEM_OIDCREQUESTURI'], "Azure");

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

        const tenantId = requireIdentityField(serviceConnectionID, "tenantid");

        switch (authorizationScheme) {
            case AuthorizationScheme.WorkloadIdentityFederation: {
                const spnId = requireIdentityField(serviceConnectionID, "serviceprincipalid");
                const oidcToken = await generateIdToken(serviceConnectionID);
                EnvironmentVariableHelper.registerSecret(oidcToken);

                const loginTool: ToolRunner = tasks.tool(azPath);
                loginTool.arg(["login", "--service-principal",
                    "--username", spnId,
                    "--tenant", tenantId,
                    "--allow-no-subscriptions",
                    "--federated-token", oidcToken]);

                await this.execAzLogin(loginTool);
                break;
            }
            case AuthorizationScheme.ServicePrincipal: {
                const spnId = requireIdentityField(serviceConnectionID, "serviceprincipalid");
                const spnKey = requireSecretField(serviceConnectionID, "serviceprincipalkey");
                EnvironmentVariableHelper.registerSecret(spnKey);

                const loginTool: ToolRunner = tasks.tool(azPath);
                loginTool.arg(["login", "--service-principal",
                    "--username", spnId,
                    "--password", spnKey,
                    "--tenant", tenantId,
                    "--allow-no-subscriptions"]);

                await this.execAzLogin(loginTool);
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

                await this.execAzLogin(loginTool);
                break;
            }
        }

        if (subscriptionId) {
            const setTool: ToolRunner = tasks.tool(azPath);
            setTool.arg(["account", "set", "--subscription", subscriptionId]);
            await this.commandExecutor.execWithTimeout(
                setTool,
                <IExecOptions>{ silent: true },
                AZ_LOGIN_TIMEOUT_MS,
                tasks.loc("TerraformAzLoginTimedOut", AZ_LOGIN_TIMEOUT_MINUTES),
            );
        }

        tasks.debug("az login completed successfully.");
    }

    /**
     * Runs an already-argv-built `az login` ToolRunner and throws on a non-zero
     * exit code. Factored out of runAzLogin's three AuthorizationScheme branches,
     * which build different login argv but otherwise repeated this exact
     * exec-and-check sequence verbatim (#732).
     */
    private async execAzLogin(loginTool: ToolRunner): Promise<void> {
        const loginResult = await this.commandExecutor.execWithTimeout(
            loginTool,
            <IExecOptions>{ silent: true },
            AZ_LOGIN_TIMEOUT_MS,
            tasks.loc("TerraformAzLoginTimedOut", AZ_LOGIN_TIMEOUT_MINUTES),
        );
        if (loginResult !== 0) {
            throw new Error(`az login failed with exit code ${loginResult}`);
        }
    }


    private async setCommonVariables(authorizationScheme: AuthorizationScheme, serviceConnectionID: string, fallbackToIdTokenGeneration: boolean, useCliFlagsForBackend: boolean): Promise<void> {
        // Clear EVERY ARM_* credential selector before any branch injects its own
        // (#187). Doing it once here rather than only per-branch closes the case
        // no per-branch list can: an inherited ARM_CLIENT_ID on the MSI path,
        // where the branch legitimately MAY set that variable (a user-assigned
        // identity) and so cannot blanket-clear it. ARM_SUBSCRIPTION_ID is
        // deliberately absent from this list -- the caller resolves and sets it
        // before calling this method.
        neutralizeEnvironmentVariables(ARM_CREDENTIAL_SELECTOR_ENV, "Azure");
        // ARM_USE_CLI is cleared above like every other selector, but clearing
        // is not disabling: azurerm's own use_cli default is TRUE, so an absent
        // ARM_USE_CLI does not turn CLI auth off -- it restores azurerm's
        // default, which is CLI auth ON. Every scheme this switch handles (MSI,
        // WIF, ServicePrincipal) authenticates via the variables it sets below,
        // never via an ambient `az` CLI session, so CLI auth is never wanted
        // here -- explicitly disable it rather than relying on absence (#1029).
        EnvironmentVariableHelper.setEnvironmentVariable("ARM_USE_CLI", "false");
        // optional=false already threw for an absent tenant, so the `?? ''` tail
        // was unreachable (#194); requireIdentityField keeps the same fail-closed
        // contract while adding the charset validation the injected value never
        // had (#199) and a message that names the field.
        EnvironmentVariableHelper.setEnvironmentVariable("ARM_TENANT_ID", requireIdentityField(serviceConnectionID, "tenantid"));

        switch (authorizationScheme) {
            case AuthorizationScheme.ManagedServiceIdentity: {
                // @credential-exempt: ManagedServiceIdentity deliberately requires no
                // credential field -- the agent's own managed identity IS the intended
                // principal, and the connection's optional client id only disambiguates
                // a user-assigned identity (see getManagedIdentityClientId).
                // The azurerm provider only reaches that identity while the
                // secret/OIDC/certificate variables are absent, so an inherited one
                // must be cleared or it silently selects a different principal (#187).
                neutralizeEnvironmentVariables(
                    [ARM_IDENTITY_SELECTORS.secret, ARM_IDENTITY_SELECTORS.oidcToken, ARM_IDENTITY_SELECTORS.certPath, ARM_IDENTITY_SELECTORS.cert, ARM_IDENTITY_SELECTORS.useOidc],
                    "Azure Managed Identity");
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
                neutralizeEnvironmentVariables(
                    [ARM_IDENTITY_SELECTORS.secret, ARM_IDENTITY_SELECTORS.certPath, ARM_IDENTITY_SELECTORS.cert, ARM_IDENTITY_SELECTORS.useMsi],
                    "Azure Workload Identity Federation");
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
                        // ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID is azurerm's documented
                        // primary variable for the ADO service connection ID (matching the
                        // ado_pipeline_service_connection_id backend-config key above);
                        // ARM_OIDC_AZURE_SERVICE_CONNECTION_ID is kept as the
                        // AzAPI-compatibility fallback name azurerm also honors, so AzAPI
                        // users are unaffected (#572).
                        EnvironmentVariableHelper.setEnvironmentVariable("ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID", serviceConnectionID);
                        EnvironmentVariableHelper.setEnvironmentVariable("ARM_OIDC_AZURE_SERVICE_CONNECTION_ID", serviceConnectionID);
                    }
                    // SECURITY (#761): this default "ID token refresh" path exports the
                    // pipeline's broad System.AccessToken (the SystemVssConnection AccessToken)
                    // into the terraform child process as ARM_OIDC_REQUEST_TOKEN so azurerm can
                    // refresh its own OIDC token mid-run. Unlike the one-shot ARM_OIDC_TOKEN
                    // minted when environmentAzureRmUseIdTokenGeneration=true, this token stays
                    // valid for the life of the job, can call back to Azure DevOps, and is
                    // inherited by any local-exec provisioner or external data source. Pipelines
                    // running untrusted third-party modules on shared agents should prefer
                    // environmentAzureRmUseIdTokenGeneration=true. See
                    // docs/setup/azure-wif-setup.md ("Token modes and exposure").
                    const accessToken = tasks.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
                    if (!accessToken) {
                        throw new Error("AccessToken not found in SystemVssConnection. Ensure the pipeline has OIDC enabled.");
                    }
                    EnvironmentVariableHelper.registerSecret(accessToken);
                    EnvironmentVariableHelper.setEnvironmentVariable("ARM_OIDC_REQUEST_TOKEN", accessToken, true);
                    // #1026 follow-up: that fix clears SYSTEM_OIDCREQUESTURI at the end of
                    // both Azure entry points, which was the ONLY name carrying this URL --
                    // azurerm resolves oidc_request_url from ARM_OIDC_REQUEST_URL ->
                    // ACTIONS_ID_TOKEN_REQUEST_URL -> SYSTEM_OIDCREQUESTURI and the task sets
                    // neither of the first two, so refresh mode lost its endpoint and fell
                    // through to the Azure CLI authorizer. Pin the validated value here, which
                    // also upgrades the pre-#1026 behaviour: the provider used to consume the
                    // ambient value unvalidated.
                    const oidcRequestUrl = resolveOidcRequestUrl();
                    if (oidcRequestUrl) {
                        EnvironmentVariableHelper.setEnvironmentVariable("ARM_OIDC_REQUEST_URL", oidcRequestUrl);
                    }
                }

                break;
            }

            case AuthorizationScheme.ServicePrincipal: {
                tasks.warning("Client secret authentication is not secure and will be deprecated in the next major version of this task. Please use Workload identity federation authentication instead.");

                const servicePrincipalCredentials = this.getServicePrincipalCredentials(serviceConnectionID);
                EnvironmentVariableHelper.registerSecret(servicePrincipalCredentials.servicePrincipalKey);
                neutralizeEnvironmentVariables(
                    [ARM_IDENTITY_SELECTORS.oidcToken, ARM_IDENTITY_SELECTORS.certPath, ARM_IDENTITY_SELECTORS.cert, ARM_IDENTITY_SELECTORS.useMsi, ARM_IDENTITY_SELECTORS.useOidc],
                    "Azure service principal");
                EnvironmentVariableHelper.setEnvironmentVariable("ARM_CLIENT_ID", servicePrincipalCredentials.servicePrincipalId);
                EnvironmentVariableHelper.setEnvironmentVariable("ARM_CLIENT_SECRET", servicePrincipalCredentials.servicePrincipalKey, true);
                break;
            }
        }
    }

    /**
     * #97: both fields were read with optional=true behind a `!`, so a service
     * connection missing either one produced `undefined`, which
     * setEnvironmentVariable then skipped with a warning -- leaving ARM_CLIENT_ID
     * and/or ARM_CLIENT_SECRET unset and the azurerm provider free to fall back
     * to the agent's ambient identity. Both now fail closed, and the id is
     * charset-validated like every other injected identity field (#199).
     */
    private getServicePrincipalCredentials(serviceConnectionID: string): ServicePrincipalCredentials {
        return {
            servicePrincipalId: requireIdentityField(serviceConnectionID, "serviceprincipalid"),
            servicePrincipalKey: requireSecretField(serviceConnectionID, "serviceprincipalkey")
        };
    }

    /**
     * The branch #97 REOPENED over in the sibling packer extension: the
     * ServicePrincipal path above was hardened while this one kept reading
     * `serviceprincipalid` as optional behind a `!`, so an empty client id
     * yielded a silently skipped ARM_CLIENT_ID with ARM_USE_OIDC still set --
     * the azurerm provider then resolved an identity from the agent instead.
     */
    private async getWorkloadIdentityFederationCredentials(serviceConnectionID: string, getIdToken: boolean): Promise<WorkloadIdentityFederationCredentials> {
        const workloadIdentityFederationCredentials: WorkloadIdentityFederationCredentials = {
            servicePrincipalId: requireIdentityField(serviceConnectionID, "serviceprincipalid"),
            oidcToken: ""
        }
        if (getIdToken) {
            workloadIdentityFederationCredentials.oidcToken = await generateIdToken(serviceConnectionID);
        }
        return workloadIdentityFederationCredentials;
    }

    /**
     * #97: an absent authorization scheme used to default to Workload Identity
     * Federation with only a warning, and the parameter was typed `string` while
     * the caller passed `getEndpointAuthorizationScheme(id, true)!` -- optional,
     * so genuinely `string | undefined` at runtime. The `!` and the
     * `=== undefined` check contradicted each other, and the silent default meant
     * a service connection with no scheme still produced a credential-less WIF
     * setup, which the azurerm provider then completed from whatever ambient
     * identity the agent had (Azure CLI login or managed identity). The parameter
     * is now typed honestly and an absent scheme fails closed, matching the
     * AWS/GCP/OCI handlers and the sibling packer extension.
     */
    private mapAuthorizationScheme(authorizationScheme: string | undefined, serviceConnectionID: string): AuthorizationScheme {
        if (!authorizationScheme) {
            throw new Error(`Service connection '${serviceConnectionID}' has no authorization scheme. Expected one of: WorkloadIdentityFederation, ManagedServiceIdentity, ServicePrincipal.`);
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
