import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.11.6');
        tl.setResult(tl.TaskResult.Succeeded, 'OpenTofuMirrorCosignVerifyFailL0 should have failed but succeeded.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, 'OpenTofuMirrorCosignVerifyFailL0 failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

run();
