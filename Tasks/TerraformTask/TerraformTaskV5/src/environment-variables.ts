import tasks = require('azure-pipelines-task-lib/task');

export class EnvironmentVariableHelper {
    private static readonly trackedVariables: Set<string> = new Set();
    // Every VALUE (not just variable name) this helper has setSecret()'d during
    // the current command, so a later consumer (e.g. the apply-summary's
    // freeform-diagnostic scrub, #694) can thread them into an exact-match
    // redaction pass instead of relying solely on a length/entropy heuristic.
    // Covers only credentials injected via THIS helper's isSecret=true path
    // (the standard mechanism the provider handlers use for cloud
    // credentials) -- a value passed directly to tasks.setSecret() elsewhere
    // (e.g. an ephemeral WIF token) is not tracked here and still relies on
    // the heuristic alone, same as before.
    private static readonly trackedSecretValues: Set<string> = new Set();

    public static setEnvironmentVariable(name: string, value: string, isSecret: boolean = false): void {
        if (!name) {
            tasks.debug("Skipped setting environment variable: name was empty.");
            return;
        }
        if (!value) {
            tasks.warning(`Environment variable '${name}' was not set because the value was empty or undefined. This may indicate a misconfiguration.`);
            return;
        }
        if (isSecret) {
            tasks.setSecret(value);
            this.trackedSecretValues.add(value);
        }
        process.env[name] = value;
        this.trackedVariables.add(name);
        tasks.debug(`Set environment variable: ${name}${isSecret ? ' (secret)' : ''}`);
    }

    /** Every secret value registered via setEnvironmentVariable(..., true) so far this command. */
    public static getTrackedSecretValues(): string[] {
        return [...this.trackedSecretValues];
    }

    public static clearTrackedVariables(): void {
        for (const name of this.trackedVariables) {
            delete process.env[name];
            tasks.debug(`Cleared environment variable: ${name}`);
        }
        this.trackedVariables.clear();
        this.trackedSecretValues.clear();
    }
}