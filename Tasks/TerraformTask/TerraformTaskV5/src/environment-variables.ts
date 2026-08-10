import tasks = require('azure-pipelines-task-lib/task');

export class EnvironmentVariableHelper {
    private static readonly trackedVariables: Set<string> = new Set();
    // Every VALUE (not just variable name) this task has setSecret()'d during the
    // current command, so a later consumer (e.g. the apply-summary's
    // freeform-diagnostic scrub, #694) can thread them into an exact-match
    // redaction pass instead of relying solely on a length/entropy heuristic.
    // Populated both by this helper's isSecret=true path and by registerSecret()
    // below, which every direct masking site calls (#886).
    private static readonly trackedSecretValues: Set<string> = new Set();

    /**
     * Masks `value` and records it for the exact-match scrub. Federated
     * credentials (the ADO OIDC JWT, the OCI UPST, the ephemeral RSA key, the PAR
     * URL) are minted mid-command and never become environment variables, so
     * before this they were masked but invisible to scrubSecrets() and covered
     * only by its 40-char entropy heuristic -- on build attachments, which are
     * not agent-masked, that heuristic was the sole control (#886).
     */
    public static registerSecret(value: string | undefined | null): void {
        if (!value) return;
        tasks.setSecret(value);
        this.trackedSecretValues.add(value);
    }

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
            this.registerSecret(value);
        }
        process.env[name] = value;
        this.trackedVariables.add(name);
        tasks.debug(`Set environment variable: ${name}${isSecret ? ' (secret)' : ''}`);
    }

    /** Every secret value this task has masked so far this command. */
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