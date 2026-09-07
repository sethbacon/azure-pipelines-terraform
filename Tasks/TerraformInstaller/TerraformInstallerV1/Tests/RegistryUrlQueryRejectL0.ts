import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        tl.setResult(tl.TaskResult.Succeeded, 'RegistryUrlQueryRejectL0 should have failed: the base URL guard did not fire.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'RegistryUrlQueryRejectL0 failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

run();
