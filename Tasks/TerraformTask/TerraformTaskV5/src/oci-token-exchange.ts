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

    // JWK thumbprint of the ephemeral public key for binding
    const jwkThumbprint = computeJwkThumbprint(publicKeyPem);

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: oidcToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        requested_token_type: 'urn:oci:token-type:oci-upst',
        client_id: clientId,
        public_key: jwkThumbprint,
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
 * Compute a JWK thumbprint (RFC 7638) of an RSA public key.
 * OCI Identity Domains uses this to bind the UPST to the ephemeral key pair.
 */
function computeJwkThumbprint(publicKeyPem: string): string {
    const keyObject = crypto.createPublicKey(publicKeyPem);
    const jwk = keyObject.export({ format: 'jwk' }) as { e: string; kty: string; n: string };

    // Canonical JWK for RSA: {"e":"...","kty":"RSA","n":"..."} (alphabetical order)
    const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
    return crypto.createHash('sha256').update(canonical).digest('base64url');
}
