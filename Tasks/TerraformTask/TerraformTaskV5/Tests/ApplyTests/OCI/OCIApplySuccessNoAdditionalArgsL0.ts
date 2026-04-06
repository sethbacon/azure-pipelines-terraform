import { TerraformCommandHandlerOCI } from './../../../src/oci-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerOCI = new TerraformCommandHandlerOCI();

export async function run() {
    try {
        const response = await handler.apply();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'OCIApplySuccessNoAdditionalArgsL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'OCIApplySuccessNoAdditionalArgsL0 should have succeeded but failed.');
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'OCIApplySuccessNoAdditionalArgsL0 should have succeeded but failed.');
    }
}

run();
