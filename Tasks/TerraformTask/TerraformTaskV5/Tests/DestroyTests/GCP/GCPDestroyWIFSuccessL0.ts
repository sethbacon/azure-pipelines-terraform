import { TerraformCommandHandlerGCP } from './../../../src/gcp-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerGCP = new TerraformCommandHandlerGCP();

export async function run() {
    try {
        const response = await handler.destroy();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'GCPDestroyWIFSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'GCPDestroyWIFSuccessL0 should have succeeded but failed.');
        }
    } catch(error: any) {
        tl.setResult(tl.TaskResult.Failed, 'GCPDestroyWIFSuccessL0 should have succeeded but failed: ' + error.message);
    }
}

run();
