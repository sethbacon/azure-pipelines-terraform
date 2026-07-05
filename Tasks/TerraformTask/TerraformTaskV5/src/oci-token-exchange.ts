import tasks = require('azure-pipelines-task-lib/task');
import crypto = require('crypto');

/**
 * Bound a remote response body before it is interpolated into a thrown error,
 * so a large or credential-reflecting body cannot be dumped wholesale into the
 * build log.
 */
function truncateBody(body: string, max = 500): string {
    return body.length > max ? `${body.slice(0, max)}… (truncated)` : body;
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
                body: body.toString(),
                signal: controller.signal,
                // Never follow a redirect: a 3xx could forward the OIDC bearer JWT
                // (preserved with the POST body) to a different, unvalidated origin.
                redirect: 'manual',
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Timed out exchanging OIDC token for OCI UPST (30s timeout).`);
            }
            throw new Error(`Failed to exchange OIDC token for OCI UPST: ${error instanceof Error ? error.message : error}`);
        }

        // With redirect:'manual', fetch surfaces a redirect as an opaque response
        // (type 'opaqueredirect', status 0) or, on some runtimes, the raw 3xx.
        // Treat either as a refusal — do not chase it with the token in hand.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            throw new Error(
                `OCI token exchange endpoint returned a redirect (status ${response.status}); ` +
                `refusing to forward the OIDC token to another origin.`
            );
        }

        if (!response.ok) {
            // Read the error body while the abort timer is still armed so a stalled
            // body cannot hang the task, and truncate it before interpolation.
            const errorBody = await response.text().catch(() => '(unable to read response body)');
            throw new Error(`OCI token exchange failed: HTTP ${response.status} ${response.statusText}. Body: ${truncateBody(errorBody)}`);
        }

        // Read the success body while the abort timer is still armed, so a server
        // that sends headers then stalls the body is still bounded by the timeout.
        const result = await response.json() as { access_token?: string; token?: string };
        const upst = result.access_token || result.token;
        if (!upst) {
            throw new Error('OCI token exchange response missing access_token/token field.');
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
