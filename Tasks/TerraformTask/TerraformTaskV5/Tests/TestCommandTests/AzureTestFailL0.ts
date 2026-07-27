import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

/**
 * Regression guard for #826: a non-zero `terraform test` exit must surface
 * TerraformTestFailed with the actual captured stdout/stderr detail folded
 * in, not just a bare exit-code message -- runTestCommand() previously had
 * zero failure-path coverage at all.
 */
async function run(): Promise<void> {
    let thrown: unknown;
    try {
        await new TerraformCommandHandlerAzureRM().test();
    } catch (error) {
        thrown = error;
    }

    if (!thrown) {
        tl.setResult(tl.TaskResult.Failed, 'AzureTestFailL0: test() should have thrown on a non-zero exit code but did not.');
        return;
    }
    // Without a loaded resource file the mock tasks.loc() falls back to the
    // message KEY itself (see other strict-failure tests in this suite for
    // the same pattern), so assert on the key rather than the formatted text.
    if (!String(thrown).includes('TerraformTestFailed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureTestFailL0: unexpected error: ${thrown}`);
        return;
    }
    if (!String(thrown).includes('Failure! 0 passed, 1 failed.')) {
        tl.setResult(tl.TaskResult.Failed, `AzureTestFailL0: captured stdout detail was not folded into the thrown error: ${thrown}`);
        return;
    }
    if (!String(thrown).includes('Error: Test run failed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureTestFailL0: captured stderr detail was not folded into the thrown error: ${thrown}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureTestFailL0 should have succeeded.');
}

void run();
