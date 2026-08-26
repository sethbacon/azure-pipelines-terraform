import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('latest');
        tl.setResult(tl.TaskResult.Succeeded, 'RegistryLatestUrlPrivateHostRejectL0 should have succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'RegistryLatestUrlPrivateHostRejectL0 failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

run();
