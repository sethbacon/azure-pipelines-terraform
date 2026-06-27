import tasks = require('azure-pipelines-task-lib/task');
import { createHttpsClient } from './http';
import { RegistryPublisher, RegistryType } from './types';
import { PrivateRegistryPublisher } from './private-publisher';
import { HcpPublisher } from './hcp-publisher';

function requireInput(name: string): string {
    const value = tasks.getInput(name, true);
    if (!value) {
        throw new Error(`Input '${name}' is required.`);
    }
    return value;
}

function parseTimeout(): number {
    const parsed = parseInt(tasks.getInput('timeoutSeconds', false) || '180', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

function buildPublisher(): RegistryPublisher {
    const registryType = requireInput('registryType') as RegistryType;
    const coordinates = {
        namespace: requireInput('namespace'),
        name: requireInput('name'),
        provider: requireInput('provider'),
        version: requireInput('version'),
    };
    const waitForPublish = tasks.getBoolInput('waitForPublish', false);
    const timeoutSeconds = parseTimeout();

    if (registryType === 'private') {
        const skipTlsVerify = tasks.getBoolInput('skipTlsVerify', false);
        if (skipTlsVerify) {
            tasks.warning(
                'skipTlsVerify is enabled: TLS certificate validation is DISABLED for the private registry connection, ' +
                'so the API key is sent over an unverified TLS channel. Use only for an internal registry fronted by a ' +
                'private CA the agent does not trust.',
            );
        }
        const apiKey = requireInput('apiKey');
        tasks.setSecret(apiKey);
        return new PrivateRegistryPublisher(createHttpsClient(!skipTlsVerify), {
            ...coordinates,
            registryUrl: requireInput('registryUrl'),
            apiKey,
            waitForPublish,
            timeoutSeconds,
        });
    }

    if (registryType === 'hcp') {
        const token = requireInput('hcpToken');
        tasks.setSecret(token);
        return new HcpPublisher(createHttpsClient(true), {
            ...coordinates,
            address: tasks.getInput('hcpAddress', false) || 'https://app.terraform.io',
            token,
            vcsRepoIdentifier: tasks.getInput('vcsRepoIdentifier', false) || '',
            vcsBranch: tasks.getInput('vcsBranch', false) || 'main',
            vcsOauthTokenId: tasks.getInput('vcsOauthTokenId', false) || '',
            commitSha: tasks.getInput('commitSha', false) || '',
            waitForPublish,
            timeoutSeconds,
        });
    }

    throw new Error(`Unsupported registryType '${registryType}'. Expected 'hcp' or 'private'.`);
}

async function run(): Promise<void> {
    try {
        const result = await buildPublisher().publish();
        console.log(result.message);
        tasks.setResult(tasks.TaskResult.Succeeded, result.message);
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();
