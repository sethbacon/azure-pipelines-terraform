import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

/**
 * Regression guard for #826: a genuine crash during `terraform fmt -check`
 * (diagnostic on stderr, no stdout) must surface as the generic
 * TerraformFmtFailed message, not be misclassified as
 * TerraformFmtNotFormatted -- which is keyed off stdout's file-list output
 * specifically. Uses a custom validation function (not the generic
 * runCommand helper) so the exact message key can be asserted.
 */
async function run(): Promise<void> {
    let thrown: unknown;
    try {
        await new TerraformCommandHandlerAzureRM().fmt();
    } catch (error) {
        thrown = error;
    }

    if (!thrown) {
        tl.setResult(tl.TaskResult.Failed, 'FmtCheckCrashL0: fmt() should have thrown on a stderr-only crash but did not.');
        return;
    }
    // Without a loaded resource file the mock tasks.loc() falls back to the
    // message KEY itself (see other strict-failure tests in this suite for
    // the same pattern), so assert on the key rather than the formatted text.
    if (String(thrown).includes('TerraformFmtNotFormatted')) {
        tl.setResult(tl.TaskResult.Failed, `FmtCheckCrashL0: a stderr-only crash was misclassified as TerraformFmtNotFormatted: ${thrown}`);
        return;
    }
    if (!String(thrown).includes('TerraformFmtFailed')) {
        tl.setResult(tl.TaskResult.Failed, `FmtCheckCrashL0: unexpected error: ${thrown}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'FmtCheckCrashL0 should have succeeded.');
}

void run();
