import { TerraformCommandHandlerHCP } from './../../../src/hcp-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerHCP = new TerraformCommandHandlerHCP();

export async function run() {
    try {
        const response = await handler.init();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'HCPInitSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'HCPInitSuccessL0 should have succeeded but failed.');
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'HCPInitSuccessL0 should have succeeded but failed: ' + error.message);
    }
}

run();
