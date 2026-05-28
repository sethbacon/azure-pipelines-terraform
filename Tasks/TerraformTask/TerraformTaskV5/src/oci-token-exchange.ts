import tasks = require('azure-pipelines-task-lib/task');
import crypto = require('crypto');

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
    const tokenEndpoint = `${identityDomainUrl.replace(/\/+$/, '')}/oauth2/v1/token`;

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
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        response = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Timed out exchanging OIDC token for OCI UPST (30s timeout).`);
        }
        throw new Error(`Failed to exchange OIDC token for OCI UPST: ${error instanceof Error ? error.message : error}`);
    }

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '(unable to read response body)');
        throw new Error(`OCI token exchange failed: HTTP ${response.status} ${response.statusText}. Body: ${errorBody}`);
    }

    const result = await response.json() as { access_token?: string; token?: string };
    const upst = result.access_token || result.token;
    if (!upst) {
        throw new Error('OCI token exchange response missing access_token/token field.');
    }

    tasks.debug('Successfully exchanged OIDC JWT for OCI UPST.');
    return upst;
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
