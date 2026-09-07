import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import * as installer from './terraform-docs-installer';

async function configureTerraformDocs() {
    const inputVersion = tasks.getInput("version", true)!;
    const toolPath = await installer.downloadTerraformDocs(inputVersion);
    const envPath = process.env['PATH'];

    if (envPath && !envPath.startsWith(path.dirname(toolPath))) {
        tools.prependPath(path.dirname(toolPath));
    }
}

async function verifyTerraformDocs() {
    console.log(tasks.loc("VerifyInstallation"));
    const toolPath = tasks.which("terraform-docs", true);
    const toolRunner: ToolRunner = tasks.tool(toolPath);
    toolRunner.arg("version");
    return toolRunner.exec();
}

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    // #1113: this task writes no sensitive temp file, so cleanup() is a
    // deliberate no-op -- the handler is still registered so a cancelled run
    // dies promptly instead of lingering (registering a signal listener
    // suppresses Node's default terminate-on-signal behavior, so the signal
    // must be re-raised with its default disposition after cleanup), and an
    // unawaited rejection anywhere in a helper no longer falls through to
    // Node's default handling with no tasks.setResult call and no
    // deterministic exit code.
    const cleanup = (): void => { /* No sensitive temp file/state to clean up today. */ };
    const handleTerminationSignal = (signal: NodeJS.Signals) => {
        cleanup();
        process.removeListener(signal, handleTerminationSignal);
        process.kill(process.pid, signal);
    };
    process.on('SIGTERM', handleTerminationSignal);
    process.on('SIGINT', handleTerminationSignal);
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
        await configureTerraformDocs();
        await verifyTerraformDocs();
        tasks.setResult(tasks.TaskResult.Succeeded, "");
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    } finally {
        process.removeListener('SIGTERM', handleTerminationSignal);
        process.removeListener('SIGINT', handleTerminationSignal);
    }
}

void run();
