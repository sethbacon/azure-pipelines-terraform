import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        tl.setResult(tl.TaskResult.Succeeded, 'GpgSignatureUnavailableL0 should have succeeded with a warning.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'GpgSignatureUnavailableL0 failed: ' + error.message);
    }
}

run();
