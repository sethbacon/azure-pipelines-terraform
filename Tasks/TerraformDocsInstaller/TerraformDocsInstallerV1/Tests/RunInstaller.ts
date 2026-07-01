import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { downloadTerraformDocs } from '../src/terraform-docs-installer';

// Shared "task under test" entry for the installer mock-runner suites.
tl.setResourcePath(path.join(__dirname, '..', 'task.json'));

async function run() {
  try {
    const version = tl.getInput('version', true)!;
    await downloadTerraformDocs(version);
    tl.setResult(tl.TaskResult.Succeeded, 'terraform-docs installed.');
  } catch (error) {
    tl.setResult(tl.TaskResult.Failed, error instanceof Error ? error.message : String(error));
  }
}

run();
