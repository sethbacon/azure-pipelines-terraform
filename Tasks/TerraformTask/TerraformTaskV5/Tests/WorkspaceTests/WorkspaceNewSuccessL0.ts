import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerAzureRM = new TerraformCommandHandlerAzureRM();

export async function run() {
    try {
        const response = await handler.workspace();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'WorkspaceNewSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'WorkspaceNewSuccessL0 should have succeeded but failed.');
        }
    } catch(error) {
        tl.setResult(tl.TaskResult.Failed, 'WorkspaceNewSuccessL0 should have succeeded but failed.');
    }
}

run();
