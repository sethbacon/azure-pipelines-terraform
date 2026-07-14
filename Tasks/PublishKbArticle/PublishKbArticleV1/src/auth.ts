import tasks = require('azure-pipelines-task-lib/task');
import { snRequest } from './servicenow-http';

/**
 * Obtain an OAuth token from ServiceNow using client credentials grant.
 * Masks clientSecret immediately (it's user input, not yet registered by the
 * caller) and the returned token via tasks.setSecret.
 */
export async function getOAuthToken(instance: string, clientId: string, clientSecret: string): Promise<string> {
    tasks.setSecret(clientSecret);
    const url = `https://${instance}.service-now.com/oauth_token.do`;
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });
    try {
        const response = await snRequest('POST', url, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        const token = response.data.access_token as string;
        tasks.setSecret(token);
        return token;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(tasks.loc('OAuthTokenError', msg));
    }
}

/**
 * Build a Basic auth header value from username and password.
 * Masks the password via tasks.setSecret before encoding, and separately masks
 * the base64-encoded credentials themselves -- ADO's log masking matches
 * literal registered strings, so the encoded form needs its own registration
 * even though the plain password is already masked.
 */
export function basicAuthHeader(user: string, pass: string): string {
    tasks.setSecret(pass);
    const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
    tasks.setSecret(credentials);
    return `Basic ${credentials}`;
}

/**
 * Return the standard JSON/Accept headers plus an Authorization header for
 * either OAuth bearer or Basic auth.
 */
export function getAuthHeaders(
    authType: string,
    opts: { accessToken?: string; username?: string; password?: string },
): Record<string, string> {
    if (authType === 'oauth') {
        if (!opts.accessToken) {
            throw new Error(tasks.loc('OAuthAccessTokenRequired'));
        }
        return {
            Authorization: `Bearer ${opts.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    } else if (authType === 'basic') {
        if (!opts.username || !opts.password) {
            throw new Error(tasks.loc('BasicAuthCredentialsRequired'));
        }
        return {
            Authorization: basicAuthHeader(opts.username, opts.password),
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    } else {
        throw new Error(tasks.loc('UnsupportedAuthType', authType));
    }
}
