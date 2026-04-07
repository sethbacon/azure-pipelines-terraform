import { TerraformCommandHandlerGCP } from './../../src/gcp-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerGCP = new TerraformCommandHandlerGCP();

export async function run() {
    try {
        const response = await handler.output();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'GCPOutputSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'GCPOutputSuccessL0 should have succeeded but failed.');
        }
    } catch(error) {
        tl.setResult(tl.TaskResult.Failed, 'GCPOutputSuccessL0 should have succeeded but failed.');
    }
}

run();
