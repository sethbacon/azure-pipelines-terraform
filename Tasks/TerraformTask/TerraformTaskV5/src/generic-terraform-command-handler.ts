import tasks = require('azure-pipelines-task-lib/task');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import { TerraformAuthorizationCommandInitializer } from './terraform-commands';
import { BaseTerraformCommandHandler, splitNonEmptyLines } from './base-terraform-command-handler';

export class TerraformCommandHandlerGeneric extends BaseTerraformCommandHandler {
    constructor() {
        super();
        this.providerName = "generic";
    }

    public async handleBackend(terraformToolRunner: ToolRunner): Promise<void> {
        const configFile = tasks.getInput("backendConfigFile", false);
        if (configFile && configFile.trim()) {
            terraformToolRunner.arg(`-backend-config=${configFile.trim()}`);
        }

        const configArgs = tasks.getInput("backendConfigArgs", false);
        for (const trimmed of splitNonEmptyLines(configArgs, { skipComments: true })) {
            terraformToolRunner.arg(`-backend-config=${trimmed}`);
        }
    }

    public async handleProvider(_command: TerraformAuthorizationCommandInitializer): Promise<void> {
        // @credential-exempt: the generic/local backend type has no cloud provider
        // identity. Generic backends (http, PostgreSQL, Consul, Kubernetes, ...)
        // are authenticated, if at all, by the user's own environment
        // (CONSUL_HTTP_TOKEN, TF_HTTP_*), which this task must not touch: there is
        // no service connection to read a credential from and nothing to
        // neutralize. Verified by inspection -- this method's body is empty and
        // handleBackend only forwards non-secret -backend-config arguments.
    }

    /**
     * Cross-cloud path: called instead of `handleBackend` on state-accessing
     * commands (plan/apply/...) when this generic/local backend is paired
     * with a *different* cloud's `provider` input. No-op: generic backends
     * (http, PostgreSQL, Consul, Kubernetes, ...) and the local backend are
     * authenticated, if at all, via the user's own environment variables or
     * config (e.g. CONSUL_HTTP_TOKEN, TF_HTTP_*) — there is nothing for this
     * task to inject.
     */
    public async configureBackendCredentials(): Promise<void> {
        tasks.debug('Generic/local backend requires no cross-cloud credential injection (user-managed).');
    }
}
