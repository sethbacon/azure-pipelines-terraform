import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadPolicyAgent } from '../src/policy-agent-installer';

// Shared "task under test" entry for the installer mock-runner suites.
tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        const version = tl.getInput('version', true)!;
        await downloadPolicyAgent(version);
        tl.setResult(tl.TaskResult.Succeeded, 'Policy agent installed.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

run();
