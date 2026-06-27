import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        // Reaching here means the insecure URL was not rejected — surface as success
        // so the integration test's `tr.failed` assertion catches the regression.
        tl.setResult(tl.TaskResult.Succeeded, 'RegistryInsecureUrlRejectL0 should have rejected the http download_url.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, error.message);
    }
}

run();
