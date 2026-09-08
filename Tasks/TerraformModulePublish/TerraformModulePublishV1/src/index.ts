import tasks = require('azure-pipelines-task-lib/task');
import { readUrlInput, readSecretInput } from '@4cloudguru/pipeline-task-ado';
import { assertPlainUrlBase } from '@4cloudguru/pipeline-task-core';
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
 * the on-path MITM scenario #588 flags (#588).
 *
 * registryUrl no longer needs its own unparseable-URL check here: the only call
 * site (below) always runs assertPlainUrlBase first,
 * which already requires registryUrl to parse as a URL before this function ever
 * sees it (#1110) -- so `new URL(registryUrl)` below cannot throw in practice.
 */
function assertSkipTlsVerifyNotAgainstPublicRegistry(registryUrl: string): void {
    const hostname = new URL(registryUrl).hostname.toLowerCase();
    if (hostname === 'terraform.io' || hostname.endsWith('.terraform.io')) {
        throw new Error(tasks.loc('SkipTlsVerifyPublicRegistryRejected', registryUrl));
    }
}

/**
 * private-publisher.ts and hcp-publisher.ts both build request URLs by trimming
 * a trailing slash off the base (registryUrl / hcpAddress) and concatenating a
 * fixed API path onto it, rather than resolving through the URL parser -- so a
 * query string or fragment embedded in the base silently retargets the request,
 * and userinfo in it would ride along with every bearer-authenticated request
 * built from it. Both bases therefore go through @4cloudguru/pipeline-task-core's
 * assertPlainUrlBase (the class fix for #1110 finding 2: every installer of both
 * extensions has the same concatenation) with 'reject' for userinfo, because
 * these requests carry their own token. Called directly at each read, naming
 * the input, which is the shape the replay signature for this class keys on;
 * it runs before either publisher ever builds a URL, and before the
 * skipTlsVerify guard below, which is why that guard no longer needs its own
 * unparseable-URL check.
 */

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
        const registryUrl = readUrlInput('registryUrl', true);
        assertPlainUrlBase('registryUrl', registryUrl, 'reject');
        if (skipTlsVerify) {
            assertSkipTlsVerifyNotAgainstPublicRegistry(registryUrl);
            tasks.warning(tasks.loc('SkipTlsVerifyEnabled'));
        }
        const apiKey = readSecretInput('apiKey', true);
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
        const token = readSecretInput('hcpToken', true);
        tasks.setSecret(token);
        const hcpAddress = readUrlInput('hcpAddress') || 'https://app.terraform.io';
        assertPlainUrlBase('hcpAddress', hcpAddress, 'reject');
        // See the private-registry branch above: the socket timeout is
        // intentionally decoupled from timeoutSeconds (the poll deadline).
        return new HcpPublisher(createHttpsClient(true), {
            ...coordinates,
            address: hcpAddress,
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

    // #1113: this task writes no sensitive temp file, so cleanup() is a
    // deliberate no-op -- the handler is still registered so a cancelled run
    // dies promptly instead of lingering (registering a signal listener
    // suppresses Node's default terminate-on-signal behavior, so the signal
    // must be re-raised with its default disposition after cleanup), and an
    // unawaited rejection anywhere in a helper no longer falls through to
    // Node's default handling with no tasks.setResult call and no
    // deterministic exit code.
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
        const result = await buildPublisher().publish();
        console.log(result.message);
        tasks.setResult(tasks.TaskResult.Succeeded, result.message);
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    } finally {
        process.removeListener('SIGTERM', handleTerminationSignal);
        process.removeListener('SIGINT', handleTerminationSignal);
    }
}

void run();
