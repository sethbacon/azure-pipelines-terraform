import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { createHttpsClient } from './http';
import { RegistryPublisher, RegistryType } from './types';
import { PrivateRegistryPublisher } from './private-publisher';
import { HcpPublisher } from './hcp-publisher';

function requireInput(name: string): string {
    const value = tasks.getInput(name, true);
    if (!value) {
        throw new Error(tasks.loc('InputRequired', name));
    }
    return value;
}

function parseTimeout(): number {
    const parsed = parseInt(tasks.getInput('timeoutSeconds', false) || '180', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

/**
 * skipTlsVerify only makes sense for a private/internal registry fronted by a CA
 * the agent doesn't trust -- there is never a legitimate reason to disable TLS
 * verification against a well-known PUBLIC registry endpoint, which is exactly
 * the on-path MITM scenario #588 flags. A malformed registryUrl is left alone
 * here; it surfaces its own clear error later when the publisher tries to use it.
 */
function assertSkipTlsVerifyNotAgainstPublicRegistry(registryUrl: string): void {
    let hostname: string;
    try {
        hostname = new URL(registryUrl).hostname.toLowerCase();
    } catch {
        return;
    }
    if (hostname === 'terraform.io' || hostname.endsWith('.terraform.io')) {
        throw new Error(tasks.loc('SkipTlsVerifyPublicRegistryRejected', registryUrl));
    }
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
        // guarded, not silent: rejected outright against a known public registry
        // host (#588, assertSkipTlsVerifyNotAgainstPublicRegistry above), the
        // apiKey is setSecret-masked below, the warning names the exact
        // consequence, and createHttpsClient still hard-enforces the https://
        // scheme (see http.ts / https-client.ts) so the bearer is never sent over
        // a cleartext scheme. Prefer installing the CA via NODE_EXTRA_CA_CERTS.
        const skipTlsVerify = tasks.getBoolInput('skipTlsVerify', false);
        const registryUrl = requireInput('registryUrl');
        if (skipTlsVerify) {
            assertSkipTlsVerifyNotAgainstPublicRegistry(registryUrl);
            tasks.warning(tasks.loc('SkipTlsVerifyEnabled'));
        }
        const apiKey = requireInput('apiKey');
        tasks.setSecret(apiKey);
        // createHttpsClient uses its own fixed default per-request socket timeout
        // here (not timeoutSeconds) -- timeoutSeconds is the user-configurable
        // overall wait-for-publish poll deadline below; reusing it as the socket
        // timeout would let a single stuck request hang for that same long
        // duration instead of failing fast, defeating the polling loop's
        // fast-fail-and-retry cadence.
        return new PrivateRegistryPublisher(createHttpsClient(!skipTlsVerify), {
            ...coordinates,
            registryUrl,
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
        // See the private-registry branch above: the socket timeout is
        // intentionally decoupled from timeoutSeconds (the poll deadline).
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

    throw new Error(tasks.loc('UnsupportedRegistryType', registryType));
}

async function run(): Promise<void> {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
    try {
        const result = await buildPublisher().publish();
        console.log(result.message);
        tasks.setResult(tasks.TaskResult.Succeeded, result.message);
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    }
}

void run();
