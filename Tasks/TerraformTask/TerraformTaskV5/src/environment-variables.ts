import tasks = require('azure-pipelines-task-lib/task');

export class EnvironmentVariableHelper {
    private static readonly trackedVariables: string[] = [];

    public static setEnvironmentVariable(name: string, value: string): void {
        if (!name) {
            tasks.debug("Skipped setting environment variable: name was empty.");
            return;
        }
        if (!value) {
            tasks.warning(`Environment variable '${name}' was not set because the value was empty or undefined. This may indicate a misconfiguration.`);
            return;
        }
        process.env[name] = value;
        this.trackedVariables.push(name);
        tasks.debug(`Set environment variable: ${name}`);
    }

    public static clearTrackedVariables(): void {
        for (const name of this.trackedVariables) {
            delete process.env[name];
            tasks.debug(`Cleared environment variable: ${name}`);
        }
        this.trackedVariables.length = 0;
    }
}