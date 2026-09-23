import tasks = require('azure-pipelines-task-lib/task');
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { TerraformCommandHandlerAzureRM } from './azure-terraform-command-handler';
import { TerraformCommandHandlerAWS } from './aws-terraform-command-handler';
import { TerraformCommandHandlerGCP } from './gcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from './oci-terraform-command-handler';
import { TerraformCommandHandlerGeneric } from './generic-terraform-command-handler';
import { TerraformCommandHandlerHCP } from './hcp-terraform-command-handler';
import { EnvironmentVariableHelper } from '@4cloudguru/pipeline-task-ado';
import { detectBackend, BackendRecord, BackendCloud } from './backend-detection';

export interface IParentCommandHandler {
    execute(providerName: string, command: string): Promise<number>;
    emergencyCleanup(): void;
}

/** The service connection input each cloud's *state backend* reads. */
const BACKEND_CONNECTION_INPUT: ReadonlyMap<BackendCloud, string> = new Map([
    ['azurerm', 'backendServiceArm'],
    ['aws', 'backendServiceAWS'],
    ['gcp', 'backendServiceGCP'],
    ['hcp', 'backendHCPToken'],
]);

/** The service connection input each `provider` value reads. */
const PROVIDER_CONNECTION_INPUT: ReadonlyMap<string, string> = new Map([
    ['azurerm', 'environmentServiceNameAzureRM'],
    ['aws', 'environmentServiceNameAWS'],
    ['gcp', 'environmentServiceNameGCP'],
]);

/**
 * Clouds whose *backend* credential environment variables are named
 * differently from their *provider* ones, and can therefore carry a second,
 * distinct identity in the same `terraform` process.
 *
 * Only gcs qualifies: `GOOGLE_BACKEND_CREDENTIALS` is read by the backend
 * alone and out-ranks `GOOGLE_CREDENTIALS`, which is what `handleProvider`
 * sets. The azurerm backend resolves every identity field it has
 * (`client_id`, `client_secret`, `tenant_id`, `use_oidc`, `oidc_token`,
 * `ado_pipeline_service_connection_id`, `use_msi`, ...) from the very same
 * `ARM_*` names the azurerm provider does, and the s3 backend the same
 * `AWS_*` names as the aws provider -- so on those two, whichever handler
 * writes last decides BOTH, and a second identity cannot be expressed at all.
 * Their backend-only names (`ARM_ACCESS_KEY`/`ARM_SAS_TOKEN`) carry a storage
 * shared key or SAS, not an Entra principal, so they are not a substitute for
 * the service connection the user actually named.
 */
const SAME_CLOUD_INJECTABLE: ReadonlySet<BackendCloud> = new Set<BackendCloud>(['gcp']);

/**
 * Cached `backend.config` keys that mean `terraform init` already bound the
 * backend to a credential of its own, so it does NOT resolve one from the
 * environment the provider also writes to. Presence of any of these makes a
 * second service connection legitimate and the run correct as-is.
 *
 * `backendAzureRmUseCliFlagsForAuthentication` is the supported way to get
 * `client_id`/`ado_pipeline_service_connection_id` in here; the rest cover a
 * backend block or `-backend-config` the pipeline author wrote themselves.
 */
const BACKEND_OWN_CREDENTIAL_CONFIG_KEYS: ReadonlyMap<BackendCloud, readonly string[]> = new Map([
    ['azurerm', ['client_id', 'client_id_file_path', 'client_secret', 'client_secret_file_path',
        'client_certificate', 'client_certificate_path', 'ado_pipeline_service_connection_id',
        'oidc_azure_service_connection_id', 'oidc_token', 'oidc_token_file_path',
        'access_key', 'sas_token', 'use_msi', 'use_cli']],
    ['aws', ['access_key', 'secret_key', 'profile', 'assume_role', 'assume_role_with_web_identity',
        'shared_credentials_files', 'shared_credentials_file', 'shared_config_files']],
    ['gcp', ['credentials', 'access_token', 'impersonate_service_account']],
    ['hcp', ['token']],
]);

/** Per-cloud detail for the error raised when two identities cannot coexist. */
const SAME_CLOUD_CONFLICT: ReadonlyMap<BackendCloud, { backendType: string; envPrefix: string; initRemedy: string }> = new Map([
    ['azurerm', {
        backendType: 'azurerm',
        envPrefix: 'ARM_*',
        initRemedy: "set backendAzureRmUseCliFlagsForAuthentication: true on the 'init' step, which caches the backend's own " +
            'client_id/use_oidc in the backend config so it no longer reads ARM_* (workload identity federation only)',
    }],
    ['aws', {
        backendType: 's3',
        envPrefix: 'AWS_*',
        initRemedy: "give the backend its own credential on the 'init' step via -backend-config (e.g. profile or " +
            'assume_role), so it no longer reads AWS_*',
    }],
]);

function readConnectionInput(inputName: string | undefined): string | undefined {
    return inputName ? tasks.getInput(inputName, false) : undefined;
}

/** Did `terraform init` already bind the backend to a credential of its own? */
function hasOwnCachedCredential(backend: BackendRecord): boolean {
    const keys = BACKEND_OWN_CREDENTIAL_CONFIG_KEYS.get(backend.cloud) || [];
    return keys.some(key => backend.configKeys.has(key));
}

function sameCloudConflictMessage(
    backendCloud: BackendCloud, command: string, backendInput: string, providerInput: string | undefined,
): string {
    const conflict = SAME_CLOUD_CONFLICT.get(backendCloud);
    const backendType = conflict?.backendType ?? backendCloud;
    const envPrefix = conflict?.envPrefix ?? `${backendCloud.toUpperCase()}_*`;
    return (
        `Refusing to run '${command}': '${backendInput}' names a different service connection than ` +
        `'${providerInput || 'the provider input'}', but the ${backendType} backend and the ${backendCloud} provider both ` +
        `resolve their identity from the same ${envPrefix} environment variables, so only one of the two can be honoured ` +
        `in a single terraform run — and it would silently be the provider's. Resolve it by any of: ` +
        `(1) ${conflict?.initRemedy ?? 'bind the backend to its own credential at init'}; ` +
        `(2) configure the provider block from input variables, since explicit provider arguments out-rank ${envPrefix}, ` +
        `leaving those environment variables to the backend — see ` +
        `docs/yaml-examples.md#separate-backend-and-provider-service-connections-same-cloud; ` +
        `(3) use the same service connection for both the backend and the provider.`
    );
}

/**
 * Commands that read or write Terraform state and therefore need the *state
 * backend's* credentials, not just the deployment provider's. When the
 * backend detected from `.terraform/terraform.tfstate` (see
 * backend-detection.ts) is a managed cloud backend whose credentials are not
 * already the provider's, the matching backend handler's
 * `configureBackendCredentials()` is invoked before the command runs — as
 * environment variables only, never `-backend-config`.
 *
 * `init` is handled separately (backendType already selects the right handler
 * and calls handleBackend()). `show` and `custom` are intentionally excluded:
 * `show` commonly targets a local saved plan file with no backend access, and
 * `custom` covers arbitrary commands (e.g. `terraform providers`, `version`)
 * that don't touch the backend either — auto-injecting for either would
 * demand backend inputs that aren't actually needed and produce a confusing
 * error. `validate`/`fmt`/`get`/`test` never touch remote state and are
 * excluded too.
 */
export const STATE_COMMANDS: ReadonlySet<string> = new Set([
    'plan', 'apply', 'destroy', 'refresh', 'import', 'output', 'state', 'workspace', 'forceunlock',
]);

export class ParentCommandHandler implements IParentCommandHandler {
    // Every handler constructed for this invocation — the provider handler,
    // plus the backend handler when cross-cloud credential injection fires —
    // tracked from the moment each is created, so cleanupTempFiles() and
    // emergencyCleanup() can always find them, including if construction,
    // injection, or command execution itself throws or a termination signal
    // arrives mid-injection.
    private handlers: BaseTerraformCommandHandler[] = [];

    public async execute(providerName: string, command: string): Promise<number> {
        const handler = command === 'init'
            // For init: backendType drives handler selection (falls back to providerName for backwards compat)
            ? this.createHandler(tasks.getInput("backendType", false) || providerName)
            // For all other commands: provider drives handler selection
            : this.createHandler(providerName);
        this.handlers.push(handler);

        try {
            if (STATE_COMMANDS.has(command)) {
                await this.injectBackendCredentials(providerName, command);
            }
            return await handler.executeCommand(command);
        } finally {
            this.cleanupAllHandlers();
        }
    }

    /**
     * Supplies the *state backend's* credentials as environment variables
     * before a state command runs, so e.g. an `aws` provider plan/apply
     * against an `azurerm` state backend can still authenticate to Azure Blob
     * Storage.
     *
     * Fires whenever the initialized backend (per
     * `.terraform/terraform.tfstate`) needs an identity the provider pass
     * won't supply: always when the clouds differ, and — since #1180 — also
     * when they match but the step named a *different* service connection for
     * the backend than for the provider. No-op for backends with no cloud
     * identity to inject (local, generic, OCI's PAR-based http backend).
     */
    private async injectBackendCredentials(providerName: string, command: string): Promise<void> {
        const workingDirectory = tasks.getInput("workingDirectory") || '';
        const backend: BackendRecord | null = detectBackend(workingDirectory);
        if (!backend) {
            return;
        }
        const backendCloud = backend.cloud;
        const sameCloud = backendCloud === providerName;

        if (sameCloud && !this.sameCloudNeedsInjection(backend, providerName, command)) {
            return;
        }

        tasks.debug(`Detected '${backendCloud}' state backend with '${providerName}' provider on command '${command}'; configuring backend credentials.`);
        const backendHandler = this.createHandler(backendCloud);
        // Tracked before the (possibly-throwing, possibly async-interrupted)
        // credential setup so its temp files are always cleaned up.
        this.handlers.push(backendHandler);

        try {
            await backendHandler.configureBackendCredentials();
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(sameCloud
                ? `State backend credential setup failed for command '${command}': the '${backendCloud}' backend was given ` +
                `its own service connection, but its inputs are incomplete. Add the '${backendCloud}' backend inputs to ` +
                `this step. Underlying error: ${reason}. See ` +
                `docs/yaml-examples.md#separate-backend-and-provider-service-connections-same-cloud for examples.`
                : `Cross-cloud state backend credential setup failed for command '${command}': detected a '${backendCloud}' ` +
                `state backend while the 'provider' input is '${providerName}'. Add the '${backendCloud}' backend inputs to ` +
                `this step so its credentials can be supplied (e.g. backendServiceArm for azurerm, backendServiceAWS for ` +
                `aws, backendServiceGCP for gcp, backendHCPToken for hcp). Underlying error: ${reason}. See ` +
                `docs/yaml-examples.md#cross-cloud-state-backends for examples.`
            );
        }
    }

    /**
     * Backend and provider are the same cloud, so the provider pass normally
     * authenticates both. Returns true only when the step nominated a
     * *separate* connection for the backend that the provider pass would
     * otherwise silently override, and throws when that separation cannot be
     * expressed at all (see {@link SAME_CLOUD_INJECTABLE}).
     */
    private sameCloudNeedsInjection(backend: BackendRecord, providerName: string, command: string): boolean {
        const backendCloud = backend.cloud;
        const backendInput = BACKEND_CONNECTION_INPUT.get(backendCloud);
        const backendConnection = readConnectionInput(backendInput);
        const providerInput = PROVIDER_CONNECTION_INPUT.get(providerName);
        const providerConnection = readConnectionInput(providerInput);

        if (!backendConnection || backendConnection === providerConnection) {
            return false;
        }

        if (hasOwnCachedCredential(backend)) {
            tasks.debug(`'${backendCloud}' backend was bound to its own credential during init; leaving the provider pass to set the shared environment variables.`);
            return false;
        }

        if (!SAME_CLOUD_INJECTABLE.has(backendCloud)) {
            throw new Error(sameCloudConflictMessage(backendCloud, command, backendInput || 'the backend input', providerInput));
        }

        return true;
    }

    private cleanupAllHandlers(): void {
        for (const handler of this.handlers) {
            handler.cleanupTempFiles();
        }
        this.handlers = [];
        EnvironmentVariableHelper.clearTrackedVariables();
    }

    public emergencyCleanup(): void {
        // Called from the SIGTERM/SIGINT/uncaughtException handlers, which can fire
        // at any point during execute() — including mid-construction of a handler,
        // input resolution, or while a (possibly cross-cloud) handler is writing its
        // credential temp files. Every handler created so far is tracked in
        // `this.handlers` from the moment it's constructed, so iterating that list
        // (rather than depending on a single "active" handler) covers that whole
        // window. clearTrackedVariables() operates on a process-wide static Set and
        // is independent of any handler, so it always runs.
        // Uses emergencyCleanupTempFiles (not cleanupTempFiles) so the retained
        // `terraform output -json` file — kept on a normal step for downstream
        // readers when cleanupOutputFile is off — is also scrubbed+deleted here:
        // a cancellation leaves no legitimate downstream reader, so its cleartext
        // (possibly sensitive) values must not linger on a reused agent (#650).
        for (const handler of this.handlers) {
            handler.emergencyCleanupTempFiles();
        }
        EnvironmentVariableHelper.clearTrackedVariables();
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

