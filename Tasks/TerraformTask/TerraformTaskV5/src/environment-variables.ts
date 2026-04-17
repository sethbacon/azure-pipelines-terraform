import tasks = require('azure-pipelines-task-lib/task');

export class EnvironmentVariableHelper {
    private static readonly trackedVariables: Set<string> = new Set();

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
        }
        process.env[name] = value;
        this.trackedVariables.add(name);
        tasks.debug(`Set environment variable: ${name}${isSecret ? ' (secret)' : ''}`);
    }

    public static clearTrackedVariables(): void {
        for (const name of this.trackedVariables) {
            delete process.env[name];
            tasks.debug(`Cleared environment variable: ${name}`);
        }
        this.trackedVariables.clear();
    }
}