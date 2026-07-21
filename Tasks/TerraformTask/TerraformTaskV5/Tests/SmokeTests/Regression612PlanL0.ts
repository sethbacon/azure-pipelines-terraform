import tl = require('azure-pipelines-task-lib');
import fs = require('fs');
import path = require('path');
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);
        const handler = new TerraformCommandHandlerAzureRM();

        const response = await handler.plan();
        if (response !== 2) {
            tl.setResult(tl.TaskResult.Failed, `Regression612PlanL0: expected plan() to return 2 (changes present), got ${response}.`);
            return;
        }

        // The USER's own -out path must exist -- proves no second, task-owned
        // -out= was injected (the broken code would have appended one AFTER the
        // user's, and terraform honors only the last -out= on the line, so
        // userplan.tfplan would never be written).
        const userPlanPath = path.join(workingDirectory, 'userplan.tfplan');
        if (!fs.existsSync(userPlanPath)) {
            tl.setResult(tl.TaskResult.Failed, "Regression612PlanL0: userplan.tfplan was not written -- a task-injected -out shadowed the user's own -out (the #612 regression).");
            return;
        }

        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'Regression612PlanL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();
