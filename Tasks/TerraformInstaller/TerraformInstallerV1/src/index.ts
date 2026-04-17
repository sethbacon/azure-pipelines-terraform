import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import * as installer from './terraform-installer';

async function configureTerraform() {
    const inputVersion = tasks.getInput("terraformVersion", true)!;
    const terraformPath = await installer.downloadTerraform(inputVersion);
    const envPath = process.env['PATH'];

    // Prepend the tools path. Instructs the agent to prepend for future tasks
    if (envPath && !envPath.startsWith(path.dirname(terraformPath))) {
        tools.prependPath(path.dirname(terraformPath));
    }
}

async function verifyTerraform() {
    console.log(tasks.loc("VerifyTerraformInstallation"));
    const binary = tasks.getInput("binary") || "terraform";
    const binaryPath = tasks.which(binary, true);
    const binaryTool: ToolRunner = tasks.tool(binaryPath);
    binaryTool.arg("version");
    return binaryTool.exec();
}

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    try {
        await configureTerraform();
        await verifyTerraform();
        tasks.setResult(tasks.TaskResult.Succeeded, "");
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();