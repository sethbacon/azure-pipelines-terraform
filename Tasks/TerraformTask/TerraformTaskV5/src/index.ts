import tasks = require('azure-pipelines-task-lib/task');
import { ParentCommandHandler } from './parent-handler';
import path = require('path');

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    const parentHandler = new ParentCommandHandler();

    // Register process-level cleanup as defense-in-depth for SIGTERM
    const cleanup = () => parentHandler.emergencyCleanup();
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    try {
        await parentHandler.execute(tasks.getInput("provider", true)!, tasks.getInput("command", true)!);
        tasks.setResult(tasks.TaskResult.Succeeded, "");
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    } finally {
        process.removeListener('SIGTERM', cleanup);
        process.removeListener('SIGINT', cleanup);
    }
}

run();
