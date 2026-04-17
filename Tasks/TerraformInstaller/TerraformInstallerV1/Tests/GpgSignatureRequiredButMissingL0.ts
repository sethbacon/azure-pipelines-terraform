import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        tl.setResult(tl.TaskResult.Succeeded, 'GpgSignatureRequiredButMissingL0 should not have succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'GpgSignatureRequiredButMissingL0 should have failed: ' + error.message);
    }
}

run();
