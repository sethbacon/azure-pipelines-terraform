import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import fs = require('fs');
import { generateProviderInstallationConfig, validateMirrorUrl, ProviderMirrorConfig } from './config-generator';
import { extractUrlUserInfoSecrets, redactUrlUserInfo } from './url-secret-redaction';

function parseMultiLineInput(input: string | undefined): string[] {
    if (!input) return [];
    return input
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    try {
        const mirrorUrl = tasks.getInput('mirrorUrl', true)!;
        const allowDirectFallback = tasks.getBoolInput('allowDirectFallback', false);
        const directExcludePatterns = parseMultiLineInput(tasks.getInput('directExcludePatterns', false));
        const directIncludePatterns = parseMultiLineInput(tasks.getInput('directIncludePatterns', false));

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
        };

        console.log(tasks.loc('GeneratingConfig', redactUrlUserInfo(mirrorUrl)));

        const hcl = generateProviderInstallationConfig(config);

        const tempDir = tasks.getVariable('Agent.TempDirectory') || process.env['AGENT_TEMPDIRECTORY'];
        if (!tempDir) {
            throw new Error(tasks.loc('AgentTempDirectoryNotSet'));
        }
        const configPath = path.join(tempDir, '.terraformrc');

        fs.writeFileSync(configPath, hcl, { encoding: 'utf8' });

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
    }
}

void run();
