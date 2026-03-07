import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        const result = await downloadTerraform('latest');
        tl.setResult(tl.TaskResult.Succeeded, 'HashiCorpLatestSuccessL0 should have succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'HashiCorpLatestSuccessL0 failed: ' + error.message);
    }
}

run();
