import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerAzureRM = new TerraformCommandHandlerAzureRM();

export async function run() {
    try {
        const response = await handler.fmt();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, 'FmtFailL0: fmt check failed as expected.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'FmtFailL0 should have failed but succeeded.');
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'FmtFailL0: fmt check failed as expected: ' + error.message);
    }
}

run();
