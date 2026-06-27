import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraform } from '../src/terraform-installer';

tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
    try {
        await downloadTerraform('1.9.8');
        // Reaching here means an empty sha256 was accepted despite requireChecksum —
        // surface as success so the integration test's `tr.failed` assertion catches it.
        tl.setResult(tl.TaskResult.Succeeded, 'RegistryEmptySha256RequireChecksumL0 should have failed closed.');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, error.message);
    }
}

run();
