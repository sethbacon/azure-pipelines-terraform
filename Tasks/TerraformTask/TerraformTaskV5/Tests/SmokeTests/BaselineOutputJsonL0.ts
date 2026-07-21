import tl = require('azure-pipelines-task-lib');
import fs = require('fs');
import { execFileSync } from 'child_process';
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        execFileSync('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: workingDirectory, stdio: 'pipe' });

        const handler = new TerraformCommandHandlerAzureRM();
        const response = await handler.output();
        if (response !== 0) {
            tl.setResult(tl.TaskResult.Failed, `BaselineOutputJsonL0: expected output() to return 0, got ${response}.`);
            return;
        }

        const outputFilePath = tl.getVariable('jsonOutputVariablesPath');
        if (!outputFilePath || !fs.existsSync(outputFilePath)) {
            tl.setResult(tl.TaskResult.Failed, 'BaselineOutputJsonL0: jsonOutputVariablesPath was not set to a real file.');
            return;
        }
        const outputJson = JSON.parse(fs.readFileSync(outputFilePath, 'utf-8'));
        if (!outputJson.env_output || outputJson.env_output.value !== 'staging') {
            tl.setResult(tl.TaskResult.Failed, `BaselineOutputJsonL0: expected env_output.value === 'staging', got: ${JSON.stringify(outputJson)}`);
            return;
        }

        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'BaselineOutputJsonL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();
