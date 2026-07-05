import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('latest');
        tl.setResult(tl.TaskResult.Failed, 'HashiCorpLatestCheckpointInvalidResponseFailL0 should have failed but succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'HashiCorpLatestCheckpointInvalidResponseFailL0 failed as expected: ' + error.message);
    }
}

run();
