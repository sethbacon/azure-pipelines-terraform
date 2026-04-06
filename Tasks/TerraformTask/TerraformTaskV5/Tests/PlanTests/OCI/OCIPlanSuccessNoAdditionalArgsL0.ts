import { TerraformCommandHandlerOCI } from './../../../src/oci-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerOCI = new TerraformCommandHandlerOCI();

export async function run() {
    try {
        const response = await handler.plan();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'OCIPlanSuccessNoAdditionalArgsL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'OCIPlanSuccessNoAdditionalArgsL0 should have succeeded but failed.');
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'OCIPlanSuccessNoAdditionalArgsL0 should have succeeded but failed.');
    }
}

run();
