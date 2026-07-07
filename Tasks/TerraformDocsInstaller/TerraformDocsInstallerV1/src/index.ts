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

    try {
        await configureTerraformDocs();
        await verifyTerraformDocs();
        tasks.setResult(tasks.TaskResult.Succeeded, "");
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();
