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
      // Under publishApplyResults (-json), terraform's own error for a
      // missing/unreadable plan file is an NDJSON diagnostic event on
      // STDOUT, not stderr (confirmed empirically) -- apply()'s
      // stderr-fold (#613) alone never covered this path. #750 folds
      // error-severity diagnostic summaries from the NDJSON stdout
      // alongside stderr, so the real terraform diagnostic text
      // ("Failed to load ... as a plan file") must now be present.
      if (!message.includes('missing.tfplan')) {
        tl.setResult(tl.TaskResult.Failed, `Regression613StderrL0: the thrown error did not include terraform's real diagnostic text (expected to mention 'missing.tfplan'). Got: ${message}`);
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

