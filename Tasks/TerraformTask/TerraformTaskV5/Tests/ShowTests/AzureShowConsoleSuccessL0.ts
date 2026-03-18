import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerAzureRM = new TerraformCommandHandlerAzureRM();

export async function run() {
    try {
        const response = await handler.show();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'AzureShowConsoleSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'AzureShowConsoleSuccessL0 should have succeeded but failed.');
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'AzureShowConsoleSuccessL0 should have succeeded but failed: ' + error);
    }
}

run();
