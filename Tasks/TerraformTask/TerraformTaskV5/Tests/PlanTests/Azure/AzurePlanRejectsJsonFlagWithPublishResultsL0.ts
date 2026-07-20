import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

/**
 * #492 follow-up: publishPlanResults re-echoes its capture to the console on
 * the assumption that it is terraform's human-readable plan output (which
 * redacts sensitive values as "(sensitive value)"). A user-supplied -json in
 * commandOptions would make that capture raw, unredacted NDJSON instead --
 * plan() must reject this combination before ever running the command,
 * rather than reproducing the exact leak #492 fixed.
 */
async function run(): Promise<void> {
  try {
    await new TerraformCommandHandlerAzureRM().plan();
    tl.setResult(tl.TaskResult.Failed, 'AzurePlanRejectsJsonFlagWithPublishResultsL0: expected plan() to throw for -json + publishPlanResults, but it succeeded.');
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/PlanJsonFlagNotSupportedWithPublishPlanResults|-json/.test(message)) {
      tl.setResult(tl.TaskResult.Failed, `AzurePlanRejectsJsonFlagWithPublishResultsL0: expected the -json/publishPlanResults rejection message, got: ${message}`);
      return;
    }
  }

  tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanRejectsJsonFlagWithPublishResultsL0 should have succeeded.');
}

run();
