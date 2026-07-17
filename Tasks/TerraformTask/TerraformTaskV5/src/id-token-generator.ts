import tasks = require("azure-pipelines-task-lib/task");
import { buildProxyFetchOptions } from './proxy-config';

export async function generateIdToken(serviceConnectionID: string): Promise<string> {
    const tokenGenerator = new TokenGenerator();
    return tokenGenerator.generate(serviceConnectionID);
}

/** Carries whether a federated-token fetch failure is worth retrying (transient) vs deterministic (4xx). */
class FederatedTokenError extends Error {
    constructor(message: string, readonly retryable: boolean) {
        super(message);
        this.name = 'FederatedTokenError';
    }
}

/** Exact hosts that identify a genuine Azure DevOps (cloud) OIDC token endpoint. */
const ADO_OIDC_HOSTS = ['dev.azure.com', 'vstoken.dev.azure.com'];
/** Host suffixes that identify a genuine Azure DevOps (cloud) OIDC token endpoint. */
const ADO_OIDC_HOST_SUFFIXES = ['.dev.azure.com', '.visualstudio.com'];

/**
 * The org label of the job's own collection URI when it is a legacy
 * *.visualstudio.com URL (e.g. 'myorg' for https://myorg.visualstudio.com/),
 * or undefined when neither collection variable exposes a comparable org --
 * the dev.azure.com form carries its org in the URL path, not the host, so no
 * host-label comparison is possible for it.
 */
function collectionVisualStudioOrgLabel(): string | undefined {
    for (const envName of ['SYSTEM_COLLECTIONURI', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI']) {
        const collectionUri = process.env[envName];
        if (!collectionUri) continue;
        try {
            const collectionHost = new URL(collectionUri).hostname.toLowerCase();
            if (collectionHost.endsWith('.visualstudio.com') && collectionHost.length > '.visualstudio.com'.length) {
                return collectionHost.split('.')[0];
            }
        } catch {
            // Unparseable collection URI -- it cannot vouch for any org.
        }
    }
    return undefined;
}

/**
 * The job's SystemVssConnection AccessToken is sent as a Bearer header to
 * SYSTEM_OIDCREQUESTURI, so in addition to the https assertion the host is
 * pinned to Azure DevOps endpoints (mirroring the OCI identity-domain suffix
 * allowlist in oci-token-exchange.ts). On-prem Azure DevOps Server hosts the
 * OIDC endpoint on the collection host itself, so a host equal to the host of
 * System.CollectionUri / System.TeamFoundationCollectionUri is also allowed.
 */
function isAllowedOidcRequestHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (ADO_OIDC_HOSTS.includes(host)) {
        return true;
    }
    for (const suffix of ADO_OIDC_HOST_SUFFIXES) {
        if (!host.endsWith(suffix) || host.length <= suffix.length) {
            continue;
        }
        // A *.visualstudio.com host carries a tenant org as its first label, so
        // a bare suffix match would admit ANY tenant's org (#554). When the
        // job's own collection URI is also a *.visualstudio.com URL, require
        // the request host's org label to match the collection's; when the
        // collection URI exposes no comparable org label (the dev.azure.com
        // form, or the variables are unset/unparseable), the plain suffix
        // match stands, unchanged. The org-less standard cloud endpoint
        // (vstoken.dev.azure.com) is exact-matched above and never reaches
        // this check.
        if (suffix === '.visualstudio.com') {
            const collectionOrg = collectionVisualStudioOrgLabel();
            if (collectionOrg !== undefined && host.split('.')[0] !== collectionOrg) {
                continue;
            }
        }
        return true;
    }
    for (const envName of ['SYSTEM_COLLECTIONURI', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI']) {
        const collectionUri = process.env[envName];
        if (!collectionUri) continue;
        try {
            if (new URL(collectionUri).hostname.toLowerCase() === host) {
                return true;
            }
        } catch {
            // Unparseable collection URI -- it cannot vouch for any host.
        }
    }
    return false;
}

export class TokenGenerator {
    private static readonly MAX_RETRIES = 3;
    private static readonly INITIAL_BACKOFF_MS = 200;

    public async generate(serviceConnectionID: string): Promise<string> {
        const oidcRequestUri = process.env["SYSTEM_OIDCREQUESTURI"];
        if (!oidcRequestUri) {
            throw new Error("SYSTEM_OIDCREQUESTURI is not set. Ensure the pipeline is running on an agent that supports OIDC token generation.");
        }
        // SYSTEM_OIDCREQUESTURI carries the job's System.AccessToken as a Bearer
        // header; assert https:// and an Azure DevOps host before that token is
        // ever sent anywhere (#353, #493).
        let parsedUri: URL;
        try {
            parsedUri = new URL(oidcRequestUri);
        } catch {
            throw new Error(`SYSTEM_OIDCREQUESTURI is not a valid URL: ${oidcRequestUri}`);
        }
        if (parsedUri.protocol !== 'https:') {
            throw new Error(`SYSTEM_OIDCREQUESTURI must be an https:// URL, got '${oidcRequestUri}'.`);
        }
        if (!isAllowedOidcRequestHost(parsedUri.hostname)) {
            throw new Error(tasks.loc('OidcRequestUriHostNotAllowed', parsedUri.hostname));
        }

        // The federated token is requested with only the service-connection id; no
        // custom audience/aud is set, so ADO issues its default-audience OIDC JWT.
        // This single requester is reused for Azure/AWS/GCP/OCI by design — each
        // cloud's relying-party federation config must constrain the token's issuer,
        // audience, and subject to this org/project/service-connection. See the WIF
        // setup guides under docs/setup/.
        const url = oidcRequestUri + "?api-version=7.1&serviceConnectionId=" + encodeURIComponent(serviceConnectionID);

        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= TokenGenerator.MAX_RETRIES; attempt++) {
            try {
                return await this.fetchToken(url, oidcRequestUri);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                // A non-FederatedTokenError is a network/DNS/abort failure -- treat as
                // transient. A deterministic 4xx (bad/expired access token,
                // misconfigured service connection) is non-retryable and skips the
                // remaining attempts and their backoff delay.
                const retryable = !(error instanceof FederatedTokenError) || error.retryable;
                if (!retryable || attempt === TokenGenerator.MAX_RETRIES) break;
                const delayMs = TokenGenerator.INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
                tasks.debug(`OIDC token request attempt ${attempt} failed: ${lastError.message}. Retrying in ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        throw lastError!;
    }

    private async fetchToken(url: string, oidcRequestUri: string): Promise<string> {
        const accessToken = tasks.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
        if (!accessToken) {
            throw new Error(
                "SystemVssConnection AccessToken is not available. " +
                "Ensure the pipeline has 'Allow scripts to access the OAuth token' enabled and OIDC is configured for the service connection."
            );
        }
        // The agent OAuth token is a bearer credential. Register it as a secret
        // in-module so masking does not depend on the agent's implicit
        // System.AccessToken registration, matching the token-refresh path.
        tasks.setSecret(accessToken);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        let oidcObject: { oidcToken: string };
        try {
            let response: Response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + accessToken
                    },
                    signal: controller.signal,
                    // This token exchange has no legitimate redirect.
                    redirect: 'error',
                    ...buildProxyFetchOptions(),
                });
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new Error(`Timed out acquiring federated token from ${oidcRequestUri} (30s timeout).`);
                }
                throw new Error(`Failed to acquire federated token from ${oidcRequestUri}: ${error instanceof Error ? error.message : error}`);
            }

            if (!response.ok) {
                // Retry only on transient failures (5xx); a deterministic 4xx
                // (bad/expired token, misconfigured service connection) will not
                // change on retry.
                throw new FederatedTokenError(`Failed to acquire federated token: HTTP ${response.status} ${response.statusText}`, response.status >= 500);
            }

            // Read the body while the abort signal is still armed, so a stalled
            // body stream is bounded by the same 30s timeout as the connection.
            try {
                oidcObject = await response.json() as { oidcToken: string };
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new Error(`Timed out acquiring federated token from ${oidcRequestUri} (30s timeout).`);
                }
                throw error;
            }
        } finally {
            // Runs on every path (success, network error, non-OK, body-parse
            // failure) -- a bare try/catch previously left the timer armed on
            // every failure, keeping the event loop alive for up to 30s/attempt.
            clearTimeout(timeoutId);
        }

        if (!oidcObject?.oidcToken) {
            throw new Error(tasks.loc("Error_FederatedTokenAquisitionFailed"));
        }

        const oidcToken = oidcObject.oidcToken;
        tasks.setSecret(oidcToken);
        return oidcToken;
    }
}
