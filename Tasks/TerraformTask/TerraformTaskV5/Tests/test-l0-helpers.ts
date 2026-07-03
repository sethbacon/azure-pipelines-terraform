import tl = require('azure-pipelines-task-lib');
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { ParentCommandHandler } from '../src/parent-handler';

/**
 * Run a command on a handler and report success/failure to the test framework.
 *
 * For success tests: sets Succeeded if the command returns the expected code.
 * For fail tests: sets Failed whether the command throws or returns any code
 * (use expectSuccess: false — the L0.ts test asserts tr.failed).
 */
export async function runCommand(
    handler: BaseTerraformCommandHandler,
    command: string,
    testName: string,
    expectSuccess: boolean = true,
    expectedCode?: number
): Promise<void> {
    try {
        const response = await (handler as any)[command]();
        const code = expectedCode !== undefined ? expectedCode : 0;
        if (expectSuccess && (response === code || response === undefined)) {
            tl.setResult(tl.TaskResult.Succeeded, `${testName} should have succeeded.`);
        } else if (!expectSuccess) {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have failed but succeeded.`);
        } else {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have succeeded but got code ${response}.`);
        }
    } catch (error) {
        if (!expectSuccess) {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have failed.`);
        } else {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have succeeded but failed: ${error}`);
        }
    }
}

/**
 * Runs a scenario through the real `ParentCommandHandler.execute()` dispatch —
 * unlike `runCommand` (which instantiates one specific provider handler and
 * calls a single command method directly) — so that cross-cloud backend
 * credential injection (which lives in ParentCommandHandler, not in any one
 * handler) is actually exercised. `provider` and `command` are read from the
 * task's own inputs, matching what the outer mock-run scenario configured.
 */
export async function runViaParentHandler(
    testName: string,
    expectSuccess: boolean = true
): Promise<void> {
    try {
        const provider = tl.getInput('provider', true)!;
        const command = tl.getInput('command', true)!;
        const response = await new ParentCommandHandler().execute(provider, command);
        if (expectSuccess) {
            tl.setResult(tl.TaskResult.Succeeded, `${testName} should have succeeded.`);
        } else {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have failed but succeeded (code ${response}).`);
        }
    } catch (error) {
        if (!expectSuccess) {
            // Include the underlying error message (not just a generic "should have
            // failed") so callers can assert on *which* error was thrown — e.g. that
            // a cross-cloud backend credential failure produced the actionable
            // message naming the missing inputs, not some other unrelated failure.
            tl.setResult(tl.TaskResult.Failed, `${testName} should have failed: ${error}`);
        } else {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have succeeded but failed: ${error}`);
        }
    }
}

