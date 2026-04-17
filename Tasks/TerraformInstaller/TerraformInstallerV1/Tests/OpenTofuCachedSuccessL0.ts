import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        const result = await downloadTerraform('1.11.6');
        tl.setResult(tl.TaskResult.Succeeded, 'OpenTofuCachedSuccessL0 should have succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'OpenTofuCachedSuccessL0 failed: ' + error.message);
    }
}

run();
