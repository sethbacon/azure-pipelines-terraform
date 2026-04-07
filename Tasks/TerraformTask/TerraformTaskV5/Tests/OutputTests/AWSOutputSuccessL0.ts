import { TerraformCommandHandlerAWS } from './../../src/aws-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

let handler: TerraformCommandHandlerAWS = new TerraformCommandHandlerAWS();

export async function run() {
    try {
        const response = await handler.output();
        if (response === 0) {
            tl.setResult(tl.TaskResult.Succeeded, 'AWSOutputSuccessL0 should have succeeded.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 'AWSOutputSuccessL0 should have succeeded but failed.');
        }
    } catch(error) {
        tl.setResult(tl.TaskResult.Failed, 'AWSOutputSuccessL0 should have succeeded but failed.');
    }
}

run();
