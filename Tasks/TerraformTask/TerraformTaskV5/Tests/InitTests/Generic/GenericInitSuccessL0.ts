import { TerraformCommandHandlerGeneric } from './../../../src/generic-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerGeneric = new TerraformCommandHandlerGeneric();

export async function run() {
    try {
        const response = await handler.init();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'GenericInitSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'GenericInitSuccessL0 should have succeeded but failed.');
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'GenericInitSuccessL0 should have succeeded but failed: ' + error.message);
    }
}

run();
