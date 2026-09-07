import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        tl.setResult(tl.TaskResult.Succeeded, 'RegistryUrlUserinfoNotLoggedL0 unexpectedly succeeded with a throwing client mock.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'RegistryUrlUserinfoNotLoggedL0 failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

run();
