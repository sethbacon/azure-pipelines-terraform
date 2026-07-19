import { TerraformCommandHandlerAzureRM } from './../../../src/azure-terraform-command-handler';
import { captureStdout } from '../../test-l0-helpers';
import tl = require('azure-pipelines-task-lib');

/**
 * #678 regression: an apply -json event's @message with an embedded newline
 * (or Unicode line/paragraph separator) followed by a `##vso[...]`-shaped
 * line must not reach the console verbatim -- the leading `##` marker must
 * be neutralized so the ADO agent cannot interpret it as a real logging
 * command, while the rest of the message's content is still printed for
 * human readability.
 */
async function run(): Promise<void> {
    let response: number | undefined;
    const stdout = await captureStdout(async () => {
        response = await new TerraformCommandHandlerAzureRM().apply();
    });

    if (response !== 0) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyMessageNeutralizesVsoInjectionL0: expected apply() to return 0, got ${response}.`);
        return;
    }

    if (stdout.includes('##vso[task.setvariable variable=pwned')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyMessageNeutralizesVsoInjectionL0: unneutralized ##vso[...] logging command reached the console. stdout: ${stdout}`);
        return;
    }

    if (!stdout.includes('Error: something failed')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyMessageNeutralizesVsoInjectionL0: expected the message's first physical line to still be echoed. stdout: ${stdout}`);
        return;
    }

    if (!stdout.includes('#vso[task.setvariable variable=pwned') || !stdout.includes('evil')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyMessageNeutralizesVsoInjectionL0: expected the injected line's content to still be visible (neutralized, not swallowed). stdout: ${stdout}`);
        return;
    }

    // U+2028 (LINE SEPARATOR) is a valid JSON string character (unescaped by
    // JSON.stringify) that some consoles render as a line break even though
    // a plain /\r?\n/ split does not treat it as one -- must be neutralized
    // just like a literal \n.
    if (stdout.includes('##vso[task.setvariable variable=pwned2')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyMessageNeutralizesVsoInjectionL0: unneutralized ##vso[...] logging command reached the console via a U+2028 line separator. stdout: ${stdout}`);
        return;
    }
    if (!stdout.includes('#vso[task.setvariable variable=pwned2') || !stdout.includes('evil2')) {
        tl.setResult(tl.TaskResult.Failed, `AzureApplyMessageNeutralizesVsoInjectionL0: expected the U+2028-injected line's content to still be visible (neutralized, not swallowed). stdout: ${stdout}`);
        return;
    }

    tl.setResult(tl.TaskResult.Succeeded, 'AzureApplyMessageNeutralizesVsoInjectionL0 should have succeeded.');
}

run();
