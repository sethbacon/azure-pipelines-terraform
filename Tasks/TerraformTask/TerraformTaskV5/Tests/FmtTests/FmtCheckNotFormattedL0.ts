import { TerraformCommandHandlerAzureRM } from './../../src/azure-terraform-command-handler';
import tl = require('azure-pipelines-task-lib');

/**
 * Coverage for #826: `terraform fmt -check` reporting unformatted files (a
 * file list on stdout, exit 1) must surface the specific
 * TerraformFmtNotFormatted message -- the positive branch that pairs with
 * FmtCheckCrashL0's crash-fallback guard. Uses a custom validation function
 * (not the message-blind runCommand helper) so the exact message KEY can be
 * asserted, proving a real unformatted-files result is not misreported as a
 * generic TerraformFmtFailed crash.
 */
async function run(): Promise<void> {
    let thrown: unknown;
    try {
        await new TerraformCommandHandlerAzureRM().fmt();
    } catch (error) {
        thrown = error;
    }

    if (!thrown) {
        tl.setResult(tl.TaskResult.Failed, 'FmtCheckNotFormattedL0: fmt() should have thrown on unformatted files but did not.');
        return;
    }
    // Without a loaded resource file the mock tasks.loc() falls back to the
    // message KEY itself (same pattern as FmtCheckCrashL0), so assert on the
    // key rather than the formatted text.
    if (String(thrown).includes('TerraformFmtFailed')) {
        tl.setResult(tl.TaskResult.Failed, `FmtCheckNotFormattedL0: unformatted files were misclassified as a generic TerraformFmtFailed crash: ${thrown}`);
        return;
    }
    if (!String(thrown).includes('TerraformFmtNotFormatted')) {
        tl.setResult(tl.TaskResult.Failed, `FmtCheckNotFormattedL0: unexpected error: ${thrown}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'FmtCheckNotFormattedL0 should have succeeded.');
}

void run();
