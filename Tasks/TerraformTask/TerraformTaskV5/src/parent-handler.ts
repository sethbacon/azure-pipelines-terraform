import tasks = require('azure-pipelines-task-lib/task');
import { BaseTerraformCommandHandler } from './base-terraform-command-handler';
import { TerraformCommandHandlerAzureRM } from './azure-terraform-command-handler';
import { TerraformCommandHandlerAWS } from './aws-terraform-command-handler';
import { TerraformCommandHandlerGCP } from './gcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from './oci-terraform-command-handler';
import { TerraformCommandHandlerGeneric } from './generic-terraform-command-handler';
import { TerraformCommandHandlerHCP } from './hcp-terraform-command-handler';
import { EnvironmentVariableHelper } from './environment-variables';
import { detectBackendCloud, BackendCloud } from './backend-detection';

export interface IParentCommandHandler {
    execute(providerName: string, command: string): Promise<number>;
    emergencyCleanup(): void;
}

/**
 * Commands that read or write Terraform state and therefore need the *state
 * backend's* credentials, not just the deployment provider's. When the
 * backend detected from `.terraform/terraform.tfstate` (see
 * backend-detection.ts) is a managed cloud backend on a *different* cloud
 * than the `provider` input, the matching backend handler's
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
                await this.injectCrossCloudBackendCredentials(providerName, command);
            }
            return await handler.executeCommand(command);
        } finally {
            this.cleanupAllHandlers();
        }
    }

    /**
     * When the working directory's initialized state backend (per
     * `.terraform/terraform.tfstate`) is a managed cloud backend that differs
     * from `providerName`, constructs that backend's handler and asks it to
     * set its credentials as environment variables — so e.g. an `aws`
     * provider plan/apply against an `azurerm` state backend can still
     * authenticate to Azure Blob Storage. No-op for same-cloud setups and for
     * backends with no cloud identity to inject (local, generic, OCI's
     * PAR-based http backend).
     */
    private async injectCrossCloudBackendCredentials(providerName: string, command: string): Promise<void> {
        const workingDirectory = tasks.getInput("workingDirectory") || '';
        const backendCloud: BackendCloud | null = detectBackendCloud(workingDirectory);
        if (!backendCloud || backendCloud === providerName) {
            return;
        }

        tasks.debug(`Detected '${backendCloud}' state backend with '${providerName}' provider on command '${command}'; configuring cross-cloud backend credentials.`);
        const backendHandler = this.createHandler(backendCloud);
        // Tracked before the (possibly-throwing, possibly async-interrupted)
        // credential setup so its temp files are always cleaned up.
        this.handlers.push(backendHandler);

        try {
            await backendHandler.configureBackendCredentials();
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Cross-cloud state backend credential setup failed for command '${command}': detected a '${backendCloud}' ` +
                `state backend while the 'provider' input is '${providerName}'. Add the '${backendCloud}' backend inputs to ` +
                `this step so its credentials can be supplied (e.g. backendServiceArm for azurerm, backendServiceAWS for ` +
                `aws, backendServiceGCP for gcp, backendHCPToken for hcp). Underlying error: ${reason}. See ` +
                `docs/yaml-examples.md#cross-cloud-state-backends for examples.`
            );
        }
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

