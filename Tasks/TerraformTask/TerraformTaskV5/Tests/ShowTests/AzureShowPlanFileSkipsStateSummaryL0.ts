import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import { captureStdout, findAttachmentCommand } from '../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');

/**
 * Heuristic gate (Phase 5 §5.5): publishStateResults set + a plan-file
 * positional argument in commandOptions ('tfplan.out') must NOT produce a
 * terraform-state-summary attachment -- this is a planfile show, which is
 * outside the state-inventory feature (and already covered by the pre-existing
 * show-of-planfile sensitive-output/destroy-change detection, left untouched
 * by this path). Only the primary command is mocked; if the production code
 * incorrectly attempted a second bare `terraform show -json` call it would hit
 * an unmocked exec answer and fail the task.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().show();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureShowPlanFileSkipsStateSummaryL0: expected show() to return 0, got ${response}.`);
        return;
    }

    const summaryAttachment = findAttachmentCommand(stdout, 'terraform-state-summary');
    if (summaryAttachment) {
        tl.setResult(tl.TaskResult.Failed, 'AzureShowPlanFileSkipsStateSummaryL0: a planfile show emitted a terraform-state-summary attachment; it should have been gated off by the positional-argument heuristic.');
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureShowPlanFileSkipsStateSummaryL0 should have succeeded.');
}

void run();
