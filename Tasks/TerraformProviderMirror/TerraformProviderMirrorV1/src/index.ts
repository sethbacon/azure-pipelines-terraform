import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { generateProviderInstallationConfig, validateMirrorUrl, ProviderMirrorConfig } from './config-generator';
import { extractUrlUserInfoSecrets, redactUrlUserInfo } from '@4cloudguru/pipeline-task-core';
import { replaceSecretFile } from '@4cloudguru/pipeline-task-ado';

function parseMultiLineInput(input: string | undefined): string[] {
    if (!input) return [];
    return input
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    // #1113: the .terraformrc this task writes is its intentional, persistent
    // OUTPUT for a later `terraform init` to consume, not a per-run secret to
    // scrub on abnormal termination, so cleanup() is a deliberate no-op -- the
    // handler is still registered so a cancelled run dies promptly instead of
    // lingering (registering a signal listener suppresses Node's default
    // terminate-on-signal behavior, so the signal must be re-raised with its
    // default disposition after cleanup), and an unawaited rejection anywhere
    // in a helper no longer falls through to Node's default handling with no
    // tasks.setResult call and no deterministic exit code.
    const cleanup = (): void => { /* No sensitive temp file/state to clean up today. */ };
    const handleTerminationSignal = (signal: NodeJS.Signals) => {
        cleanup();
        process.removeListener(signal, handleTerminationSignal);
        process.kill(process.pid, signal);
    };
    process.on('SIGTERM', handleTerminationSignal);
    process.on('SIGINT', handleTerminationSignal);
    process.on('uncaughtException', (err) => {
        cleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        cleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
        process.exit(1);
    });

    try {
        const mirrorUrl = tasks.getInput('mirrorUrl', true)!;
        const allowDirectFallback = tasks.getBoolInput('allowDirectFallback', false);
        const directExcludePatterns = parseMultiLineInput(tasks.getInput('directExcludePatterns', false));
        const directIncludePatterns = parseMultiLineInput(tasks.getInput('directIncludePatterns', false));
        const mirrorExcludePatterns = parseMultiLineInput(tasks.getInput('mirrorExcludePatterns', false));
        const mirrorIncludePatterns = parseMultiLineInput(tasks.getInput('mirrorIncludePatterns', false));

        // #960: directIncludePatterns alone never bypasses the mirror -- warn when a
        // direct-include pattern has no matching mirror exclusion, since allowDirectFallback
        // is the only condition under which the direct block (and this override) has any effect.
        if (allowDirectFallback && directIncludePatterns.length > 0) {
            const notExcludedFromMirror = directIncludePatterns.filter(p => !mirrorExcludePatterns.includes(p));
            if (notExcludedFromMirror.length > 0) {
                tasks.warning(tasks.loc('DirectIncludeNotExcludedFromMirror', notExcludedFromMirror.join(', ')));
            }
        }

        // mirrorUrl may embed basic-auth userinfo for an internal mirror. Mask it
        // before it can reach the console (the config echo below) or a validation
        // error message (#586). The real credential still goes into the generated
        // .terraformrc file — terraform needs it to reach the mirror — but never the
        // build log.
        for (const secret of extractUrlUserInfoSecrets(mirrorUrl)) {
            tasks.setSecret(secret);
        }

        validateMirrorUrl(mirrorUrl);

        const config: ProviderMirrorConfig = {
            mirrorUrl,
            allowDirectFallback,
            directExcludePatterns,
            directIncludePatterns,
            mirrorExcludePatterns,
            mirrorIncludePatterns,
        };

        console.log(tasks.loc('GeneratingConfig', redactUrlUserInfo(mirrorUrl)));

        const hcl = generateProviderInstallationConfig(config);

        const tempDir = tasks.getVariable('Agent.TempDirectory') || process.env['AGENT_TEMPDIRECTORY'];
        if (!tempDir) {
            throw new Error(tasks.loc('AgentTempDirectoryNotSet'));
        }
        const configPath = path.join(tempDir, '.terraformrc');

        // The .terraformrc carries the live mirror credential (mirrorUrl may embed
        // basic-auth userinfo), so write it with the shared hardened primitive --
        // owner-only 0600 + O_EXCL on Unix, a restrictive icacls DACL on Windows
        // (both fail closed) -- instead of a permission-less fs.writeFileSync that
        // inherits the umask and would follow a pre-planted symlink (#628, CWE-59/
        // CWE-377). replaceSecretFile (not writeSecretFile) because this fixed path
        // in Agent.TempDirectory can legitimately pre-exist from a prior run on a
        // reused self-hosted agent -- it overwrites a stale regular file but still
        // refuses a symlink. The file is NOT cleanup-tracked: terraform needs it
        // for the rest of the job (TF_CLI_CONFIG_FILE points at it).
        replaceSecretFile(configPath, hcl);

        tasks.setVariable('TF_CLI_CONFIG_FILE', configPath, false, false);
        tasks.setVariable('configFilePath', configPath, false, true);

        console.log(tasks.loc('ConfigWritten', configPath));
        console.log('--- Generated configuration ---');
        // Echo a userinfo-stripped rendering of the config: the file on disk keeps the
        // real credential (terraform needs it), but the build log must not (#586).
        const displayHcl = generateProviderInstallationConfig({ ...config, mirrorUrl: redactUrlUserInfo(mirrorUrl) });
        console.log(displayHcl);
        console.log('-------------------------------');

        tasks.setResult(tasks.TaskResult.Succeeded, '');
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    } finally {
        process.removeListener('SIGTERM', handleTerminationSignal);
        process.removeListener('SIGINT', handleTerminationSignal);
    }
}

void run();
