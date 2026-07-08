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
        // skipTlsVerify is an accepted, opt-in last resort for an internal registry
        // fronted by a private CA the agent does not trust. It is deliberately
        // guarded, not silent: the apiKey is setSecret-masked below, the warning
        // names the exact consequence, and createHttpsClient still hard-enforces the
        // https:// scheme (see http.ts / https-client.ts) so the bearer is never sent
        // over a cleartext scheme. Prefer installing the CA via NODE_EXTRA_CA_CERTS.
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
        return new PrivateRegistryPublisher(createHttpsClient(!skipTlsVerify, timeoutSeconds * 1000), {
            ...coordinates,
            registryUrl: requireInput('registryUrl'),
            apiKey,
            waitForPublish,
            timeoutSeconds,
            // Optional: when all three are set, a not-yet-registered module is
            // created + SCM-linked on 404 instead of failing (see private-publisher).
            scmProviderId: tasks.getInput('scmProviderId', false),
            repositoryOwner: tasks.getInput('repositoryOwner', false),
            repositoryName: tasks.getInput('repositoryName', false),
            defaultBranch: tasks.getInput('defaultBranch', false),
            tagPattern: tasks.getInput('tagPattern', false),
        });
    }

    if (registryType === 'hcp') {
        const token = requireInput('hcpToken');
        tasks.setSecret(token);
        return new HcpPublisher(createHttpsClient(true, timeoutSeconds * 1000), {
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
