import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        tl.setResult(tl.TaskResult.Succeeded, 'RegistryEmptySha256WarnsL0 succeeded with a skipped-verification warning.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'RegistryEmptySha256WarnsL0 should have succeeded: ' + error.message);
    }
}

run();
