import tl = require('azure-pipelines-task-lib');
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
    const workingDirectory = tl.getInput('workingDirectory')!;
    try {
        realTerraformInit(workingDirectory);

        const handler = new TerraformCommandHandlerAzureRM();
        try {
            await handler.apply();
            tl.setResult(tl.TaskResult.Failed, 'Regression613StderrL0: expected apply() to throw for a missing plan file, but it succeeded.');
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // NOTE: under publishApplyResults (-json), terraform's own error
            // for a missing/unreadable plan file is an NDJSON diagnostic event
            // on STDOUT, not stderr (confirmed empirically) -- apply()'s
            // stderr-fold (#613) does not cover this, so the message is
            // currently just the bare loc string with no diagnostic detail.
            // Filed as #750; this assertion only proves the task still FAILS
            // CLOSED (does not silently succeed) for this real failure -- once
            // #750 is fixed, tighten this to also assert the message contains
            // the real diagnostic text (mirrors Regression612Destroy.ts's note
            // about #749).
            if (!message.includes('TerraformApplyFailed')) {
                tl.setResult(tl.TaskResult.Failed, `Regression613StderrL0: unexpected failure message shape: ${message}`);
                return;
            }
        }

        handler.cleanupTempFiles();
        tl.setResult(tl.TaskResult.Succeeded, 'Regression613StderrL0 should have succeeded.');
    } finally {
        cleanupScratchFixture(workingDirectory);
    }
}

run();

