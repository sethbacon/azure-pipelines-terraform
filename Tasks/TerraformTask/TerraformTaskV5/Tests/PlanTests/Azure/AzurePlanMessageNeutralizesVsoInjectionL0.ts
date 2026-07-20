import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');

/**
 * Audit id9 (2026-07-20) regression, mirroring #678's
 * AzureApplyMessageNeutralizesVsoInjectionL0: a `##vso[...]`-shaped line
 * embedded in terraform's human-readable plan text must not reach the
 * console verbatim when publishPlanResults echoes the captured plan --
 * the leading `##` marker must be neutralized so the ADO agent cannot
 * interpret it as a real logging command, while the rest of the line's
 * content is still printed for human readability.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().plan();
    });

    // plan() returns 2 (changes present) on a successful detailed-exitcode run.
    if (response !== 2) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanMessageNeutralizesVsoInjectionL0: expected plan() to return 2, got ${response}.`);
        return;
    }

    if (stdout.includes('##vso[task.setvariable variable=pwned')) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanMessageNeutralizesVsoInjectionL0: unneutralized ##vso[...] logging command reached the console. stdout: ${stdout}`);
        return;
    }

    if (!stdout.includes('normal line')) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanMessageNeutralizesVsoInjectionL0: expected the plan text's other lines to still be echoed. stdout: ${stdout}`);
        return;
    }

    if (!stdout.includes('#vso[task.setvariable variable=pwned') || !stdout.includes('evil')) {
        tl.setResult(tl.TaskResult.Failed, `AzurePlanMessageNeutralizesVsoInjectionL0: expected the injected line's content to still be visible (neutralized, not swallowed). stdout: ${stdout}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzurePlanMessageNeutralizesVsoInjectionL0 should have succeeded.');
}

run();
