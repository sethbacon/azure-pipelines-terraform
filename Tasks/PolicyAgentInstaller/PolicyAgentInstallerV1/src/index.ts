import tasks = require('azure-pipelines-task-lib/task');
import tools = require('azure-pipelines-tool-lib/tool');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import path = require('path');
import * as installer from './policy-agent-installer';

async function configurePolicyAgent() {
    const inputVersion = tasks.getInput("version", true)!;
    const agentPath = await installer.downloadPolicyAgent(inputVersion);
    const envPath = process.env['PATH'];

    if (envPath && !envPath.startsWith(path.dirname(agentPath))) {
        tools.prependPath(path.dirname(agentPath));
    }
}

async function verifyPolicyAgent() {
    const agent = tasks.getInput("policyAgent") || "opa";
    console.log(tasks.loc("VerifyInstallation", agent));
    const agentPath = tasks.which(agent, true);
    const agentTool: ToolRunner = tasks.tool(agentPath);
    agentTool.arg("version");
    return agentTool.exec();
}

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    try {
        await configurePolicyAgent();
        await verifyPolicyAgent();
        tasks.setResult(tasks.TaskResult.Succeeded, "");
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();
