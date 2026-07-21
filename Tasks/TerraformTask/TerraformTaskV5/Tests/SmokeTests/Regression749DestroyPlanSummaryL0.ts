import tl = require('azure-pipelines-task-lib');
import fs = require('fs');
import { execFileSync } from 'child_process';
import { TerraformCommandHandlerAzureRM } from '../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../test-l0-helpers';
import { cleanupScratchFixture, realTerraformInit } from './smoke-helpers';

async function run(): Promise<void> {
  const workingDirectory = tl.getInput('workingDirectory')!;
  try {
    realTerraformInit(workingDirectory);
    // Real state to destroy, created directly (bypassing the task) so this
    // scenario tests ONLY destroy()'s own argv-build + digest mechanism.
    execFileSync('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: workingDirectory, stdio: 'pipe' });

    const handler = new TerraformCommandHandlerAzureRM();
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
      response = await handler.destroy();
    });

    if (response !== 0) {
      tl.setResult(tl.TaskResult.Failed, `Regression749DestroyPlanSummaryL0: expected destroy() to return 0, got ${response}.`);
      return;
    }

    // The real destroy must have actually happened (state is empty).
    const stateAfter = JSON.parse(execFileSync('terraform', ['show', '-json'], { cwd: workingDirectory, encoding: 'utf-8' }));
    if (stateAfter.values !== undefined) {
      tl.setResult(tl.TaskResult.Failed, `Regression749DestroyPlanSummaryL0: expected no resources left in state after destroy, got: ${JSON.stringify(stateAfter)}`);
      return;
    }

    // The destroy-plan digest must have been built and attached for real.
    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-plan-summary');
    if (!summaryAttachment) {
      tl.setResult(tl.TaskResult.Failed, 'Regression749DestroyPlanSummaryL0: no terraform-plan-summary attachment was emitted.');
      return;
    }
    if (summaryAttachment.name !== 'my-destroy-summary') {
      tl.setResult(tl.TaskResult.Failed, `Regression749DestroyPlanSummaryL0: expected attachment name 'my-destroy-summary', got '${summaryAttachment.name}'.`);
      return;
    }

    let digest: { kind: string; planMode?: string; resources: Array<{ address: string; actions: string[] }> };
    try {
      digest = JSON.parse(fs.readFileSync(summaryAttachment.path, 'utf-8'));
    } catch (error) {
      tl.setResult(tl.TaskResult.Failed, `Regression749DestroyPlanSummaryL0: attachment file was not valid JSON: ${error}`);
      return;
    } finally {
      try { fs.unlinkSync(summaryAttachment.path); } catch { /* ignore */ }
    }

    if (digest.kind !== 'plan' || digest.planMode !== 'destroy' || digest.resources.length !== 1 || digest.resources[0].address !== 'terraform_data.example') {
      tl.setResult(tl.TaskResult.Failed, `Regression749DestroyPlanSummaryL0: digest did not describe the real destroy plan: ${JSON.stringify(digest)}`);
      return;
    }

    handler.cleanupTempFiles();
    tl.setResult(tl.TaskResult.Succeeded, 'Regression749DestroyPlanSummaryL0 should have succeeded.');
  } finally {
    cleanupScratchFixture(workingDirectory);
  }
}

run();
