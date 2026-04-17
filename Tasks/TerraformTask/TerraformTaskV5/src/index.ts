import tasks = require('azure-pipelines-task-lib/task');
import { ParentCommandHandler } from './parent-handler';
import path = require('path');

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    const parentHandler = new ParentCommandHandler();

    // Register process-level cleanup as defense-in-depth for unexpected termination
    const cleanup = () => parentHandler.emergencyCleanup();
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('uncaughtException', (err) => {
        cleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        cleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
        process.exit(1);
    });

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

void run();
