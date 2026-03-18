import tl = require('azure-pipelines-task-lib');
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';

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
        if (expectSuccess && response === code) {
            tl.setResult(tl.TaskResult.Succeeded, `${testName} should have succeeded.`);
        } else if (!expectSuccess) {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have failed but succeeded.`);
        } else {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have succeeded but got code ${response}.`);
        }
    } catch (error) {
        if (!expectSuccess) {
            tl.setResult(tl.TaskResult.Succeeded, `${testName} should have failed.`);
        } else {
            tl.setResult(tl.TaskResult.Failed, `${testName} should have succeeded but failed: ${error}`);
        }
    }
}
