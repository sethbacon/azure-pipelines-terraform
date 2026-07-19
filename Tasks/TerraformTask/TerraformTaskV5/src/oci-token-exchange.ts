import tasks = require('azure-pipelines-task-lib/task');
import crypto = require('crypto');
import { buildProxyFetchOptions } from './proxy-config';
import { retryAsync, parseRetryAfterMs } from './retry';

/**
 * Number of total token-exchange attempts and the initial backoff, matching the
 * sibling ADO-side TokenGenerator (id-token-generator.ts) so the two hops of the
 * OCI WIF flow (ADO OIDC token -> OCI UPST) share one retry posture.
 */
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 200;

/**
 * Carries whether a token-exchange failure is worth retrying: a network error, a
 * timeout, a 5xx, or a 429 is transient (retryable); a received other 4xx, a
 * refused redirect, or a malformed/short body is deterministic (not retryable)
 * and won't change on a repeat. Also carries the capped Retry-After delay when
 * a retryable response supplied one.
 */
class OciTokenExchangeError extends Error {
    constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
        super(message);
        this.name = 'OciTokenExchangeError';
    }
}

/**
 * Bound a remote response body before it is interpolated into a thrown error,
 * so a large or credential-reflecting body cannot be dumped wholesale into the
 * build log.
 */
function truncateBody(body: string, max = 500): string {
    return body.length > max ? `${body.slice(0, max)}… (truncated)` : body;
}

/**
 * Remove any occurrence of a known request secret (here the OIDC subject_token
 * we just POSTed) from a remote response body before it is interpolated into a
 * thrown error, so a validation-error body that reflects the request parameter
 * back cannot leak that credential into the unmasked task-failure message
 * (#647). This is defense-in-depth on top of the caller's tasks.setSecret()
 * masking and the length truncation in truncateBody(); it runs BEFORE
 * truncation so a full secret occurrence is scrubbed even when it straddles the
 * truncation boundary. Literal split/join (no regex) avoids any ReDoS or
 * escaping concern; only non-trivial values are scrubbed so short, legitimate
 * diagnostic text is never over-redacted.
 */
function scrubSecrets(body: string, secrets: string[]): string {
    let scrubbed = body;
    for (const secret of secrets) {
        if (secret && secret.length >= 8) {
            scrubbed = scrubbed.split(secret).join('***');
        }
    }
    return scrubbed;
}

/** Bound a response body for a thrown error: scrub known request secrets, then cap length. */
function sanitizeBody(body: string, secrets: string[]): string {
    return truncateBody(scrubSecrets(body, secrets));
}

/**
 * Hostname suffixes that identify a genuine OCI Identity Domains endpoint.
 * The federated OIDC bearer JWT is POSTed to this host, so it is constrained
 * to Oracle-owned realms to prevent the token from being exfiltrated to an
 * operator-supplied or mistyped third-party origin.
 */
const OCI_IDENTITY_DOMAIN_SUFFIXES = [
    '.identity.oraclecloud.com',   // OC1 commercial
    '.identity.oraclegovcloud.com', // OC2/OC3 US government
    '.identity.oraclegovcloud.uk',  // OC4 UK government
    '.identity.oraclecloud.eu',     // OC5/EU sovereign
];

/**
 * Validate an operator-supplied OCI Identity Domains base URL before any token
 * is sent to it. Rejects non-HTTPS schemes and hosts outside the OCI Identity
 * Domains realms. Returns the parsed URL so the caller can build the endpoint
 * from a value that has actually been verified.
 */
export function validateIdentityDomainUrl(identityDomainUrl: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(identityDomainUrl);
    } catch {
        throw new Error(`OCI identity domain URL is not a valid URL: ${identityDomainUrl}`);
    }
    if (parsed.protocol !== 'https:') {
        throw new Error('OCI identity domain URL must use HTTPS scheme.');
    }
    const host = parsed.hostname.toLowerCase();
    const allowed = OCI_IDENTITY_DOMAIN_SUFFIXES.some(
        (suffix) => host.endsWith(suffix) && host.length > suffix.length
    );
    if (!allowed) {
        throw new Error(
            `OCI identity domain URL host '${parsed.hostname}' is not an OCI Identity Domains endpoint ` +
            `(expected a host under ${OCI_IDENTITY_DOMAIN_SUFFIXES.join(', ')}).`
        );
    }
    return parsed;
}

/**
 * Exchange an OIDC JWT for an OCI User Principal Session Token (UPST)
 * using the OCI Identity Domains token exchange endpoint (RFC 8693).
 *
 * The endpoint is:
 *   POST {identityDomainUrl}/oauth2/v1/token
 *
 * Requires an OCI Identity Domains application configured to accept
 * external OIDC JWTs from Azure DevOps (vstoken.dev.azure.com).
 *
 * Returns the UPST string. The caller must write it to a file and
 * reference it in an OCI config file with `security_token_file`.
 */
export async function exchangeOidcForUpst(
    oidcToken: string,
    identityDomainUrl: string,
    clientId: string,
    publicKeyPem: string
): Promise<string> {
    // Validate the destination BEFORE the federated JWT is sent anywhere.
    const validated = validateIdentityDomainUrl(identityDomainUrl);
    const base = `${validated.origin}${validated.pathname.replace(/\/+$/, '')}`;
    const tokenEndpoint = `${base}/oauth2/v1/token`;

    // The ephemeral public key is sent so OCI can bind the issued UPST to it; the
    // caller signs subsequent API requests with the matching private key. OCI
    // expects the base64-encoded SubjectPublicKeyInfo (DER), i.e. the PEM body
    // with armor and line breaks removed.
    const publicKeyDerBase64 = publicKeyToBase64Der(publicKeyPem);

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: oidcToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        requested_token_type: 'urn:oci:token-type:oci-upst',
        client_id: clientId,
        public_key: publicKeyDerBase64,
    });

    tasks.debug(`Exchanging OIDC JWT for OCI UPST at ${tokenEndpoint}`);

    // Bounded exponential-backoff retry via the shared retry helper (retry.ts),
    // matching the sibling ADO-side TokenGenerator: retry a network error, a
    // timeout, a 5xx, or a 429; never a received other 4xx, a refused redirect,
    // or a malformed/short body. Each attempt gets its own fresh 30s
    // AbortController. A capped Retry-After from a retryable response is
    // honored over the default backoff.
    // The OIDC subject_token is the only secret in the request body; pass it so
    // a reflected-parameter validation-error body is scrubbed before it reaches
    // an unmasked failure message (#647). client_id/public_key are not secret.
    return retryAsync(() => attemptExchange(tokenEndpoint, body.toString(), [oidcToken]), {
        retries: MAX_RETRIES - 1,
        baseDelayMs: INITIAL_BACKOFF_MS,
        retryError: (error) => !(error instanceof OciTokenExchangeError) || error.retryable,
        delayMs: (attempt, backoffMs, outcome) =>
            outcome.kind === 'error'
                && outcome.error instanceof OciTokenExchangeError
                && outcome.error.retryAfterMs !== undefined
                ? outcome.error.retryAfterMs
                : backoffMs,
        onRetry: (attempt, delayMs, outcome) => {
            const message = outcome.kind === 'error' && outcome.error instanceof Error ? outcome.error.message : '';
            tasks.debug(`OCI token exchange attempt ${attempt + 1} failed: ${message}. Retrying in ${delayMs}ms...`);
        },
    });
}

/**
 * A single OIDC-for-UPST token-exchange attempt, bounded by its own 30s
 * AbortController timeout (each retry gets a fresh one). Throws an
 * OciTokenExchangeError tagged retryable=true for transient failures (network
 * error, timeout, 5xx, 429) and retryable=false for deterministic ones (received
 * other 4xx, refused redirect, malformed/short body), so the shared retry loop
 * only repeats what can plausibly change.
 */
async function attemptExchange(tokenEndpoint: string, bodyString: string, secretsToScrub: string[]): Promise<string> {
    let response: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
        try {
            response = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: bodyString,
                signal: controller.signal,
                // Never follow a redirect: a 3xx could forward the OIDC bearer JWT
                // (preserved with the POST body) to a different, unvalidated origin.
                redirect: 'manual',
                ...buildProxyFetchOptions(),
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new OciTokenExchangeError(`Timed out exchanging OIDC token for OCI UPST (30s timeout).`, true);
            }
            throw new OciTokenExchangeError(`Failed to exchange OIDC token for OCI UPST: ${error instanceof Error ? error.message : error}`, true);
        }

        // With redirect:'manual', fetch surfaces a redirect as an opaque response
        // (type 'opaqueredirect', status 0) or, on some runtimes, the raw 3xx.
        // Treat either as a refusal — do not chase it with the token in hand, and
        // never retry it (a redirect won't resolve to a token on repeat).
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            throw new OciTokenExchangeError(
                `OCI token exchange endpoint returned a redirect (status ${response.status}); ` +
                `refusing to forward the OIDC token to another origin.`,
                false,
            );
        }

        if (!response.ok) {
            // Read the error body while the abort timer is still armed so a stalled
            // body cannot hang the task, and truncate it before interpolation. A 5xx,
            // or a 429 from the identity domain's rate limiting, is transient
            // (retry); a received other 4xx is deterministic (do not retry). A
            // Retry-After header on a retryable response is honored (capped) over
            // the default backoff.
            const errorBody = await response.text().catch(() => '(unable to read response body)');
            const retryable = response.status >= 500 || response.status === 429;
            throw new OciTokenExchangeError(
                `OCI token exchange failed: HTTP ${response.status} ${response.statusText}. Body: ${sanitizeBody(errorBody, secretsToScrub)}`,
                retryable,
                retryable ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined,
            );
        }

        // Read the success body while the abort timer is still armed, so a server
        // that sends headers then stalls the body is still bounded by the timeout.
        // Parsed manually (rather than response.json()) so a non-JSON body -- e.g.
        // a misconfigured gateway or captive portal answering 200 with HTML --
        // surfaces as a clear, truncated error instead of a raw SyntaxError,
        // mirroring module-publish/http.ts's parseJson().
        const bodyText = await response.text();
        let result: { access_token?: string; token?: string };
        try {
            result = JSON.parse(bodyText) as { access_token?: string; token?: string };
        } catch {
            throw new OciTokenExchangeError(`OCI token exchange returned a non-JSON response: ${sanitizeBody(bodyText, secretsToScrub)}`, false);
        }
        const upst = result.access_token || result.token;
        if (!upst) {
            throw new OciTokenExchangeError('OCI token exchange response missing access_token/token field.', false);
        }

        tasks.debug('Successfully exchanged OIDC JWT for OCI UPST.');
        return upst;
    } finally {
        // Always clear the abort timer — including on the error path — so it cannot
        // leak and keep the Node event loop alive for up to 30s after the task ends.
        clearTimeout(timeoutId);
    }
}

/**
 * Export an RSA public key as base64-encoded SubjectPublicKeyInfo (DER).
 * This is the form OCI Identity Domains expects in the token-exchange
 * `public_key` parameter so it can bind the issued UPST to the ephemeral key.
 */
function publicKeyToBase64Der(publicKeyPem: string): string {
    const keyObject = crypto.createPublicKey(publicKeyPem);
    const der = keyObject.export({ type: 'spki', format: 'der' });
    return der.toString('base64');
}
