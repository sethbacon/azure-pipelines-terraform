/**
 * Registry-provided pre-signed download URLs (Azure blob SAS, AWS S3 presigned,
 * GCS signed URL) carry a live, short-TTL storage credential in their query
 * string. azure-pipelines-tool-lib's downloadTool logs the URL at INFO and only
 * auto-redacts Azure `sig=`, so AWS `X-Amz-Signature`/`X-Amz-Credential`/
 * `X-Amz-Security-Token` and GCS `X-Goog-Signature`/`X-Goog-Credential` would
 * otherwise print unredacted on every normal registry run — and the same token
 * can leak again if a download failure echoes the raw URL in its message.
 *
 * Shared byte-for-byte across the three installer tasks that consume a registry
 * download_url plus the TerraformProviderMirror task (guarded by
 * scripts/check-shared-modules.js) so a fix here can never be applied to one copy
 * and silently missed in the others.
 *
 * A second, related leak vector this module guards: an operator-supplied
 * registry/mirror URL input (registryUrl/mirrorBaseUrl/mirrorUrl) that embeds
 * basic-auth userinfo (`https://user:password@host/...`, a real pattern for
 * internal artifact proxies). Unlike the pre-signed download_url above, this value
 * is echoed into pipeline variables, console output, and error messages on every
 * run — so its credentials must be setSecret()'d and stripped before display. See
 * extractUrlUserInfoSecrets / redactUrlUserInfo below.
 */

function isSensitiveQueryParam(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === 'sig'
        || lower.includes('signature')
        || lower.includes('credential')
        || lower.includes('token');
}

/**
 * Extracts the values of every sensitive query-string token in `url`. Values are
 * returned in the raw form they appear in the URL (still percent-encoded) so they
 * match the exact substring tool-lib logs at INFO; the decoded form is added too when
 * it differs, so a consumer that logs the decoded value is masked as well. Used to
 * setSecret() the tokens before download and to scrub them from any failure message.
 */
export function extractUrlTokenSecrets(url: string): string[] {
    const qIndex = url.indexOf('?');
    if (qIndex === -1) return [];
    const query = url.slice(qIndex + 1).split('#')[0];
    const secrets: string[] = [];
    for (const pair of query.split('&')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const name = pair.slice(0, eq);
        const rawValue = pair.slice(eq + 1);
        if (!rawValue || !isSensitiveQueryParam(name)) continue;
        secrets.push(rawValue);
        let decoded: string;
        try { decoded = decodeURIComponent(rawValue); } catch { decoded = rawValue; }
        if (decoded !== rawValue) secrets.push(decoded);
    }
    return secrets;
}

/**
 * Strips the ENTIRE query string (which can carry a pre-signed signature/token —
 * Azure `sig`, AWS `X-Amz-Signature`/`X-Amz-Credential`/`X-Amz-Security-Token`,
 * GCS `X-Goog-Signature`/`X-Goog-Credential`) from a URL for safe logging. The whole
 * query is dropped rather than redacting known parameter names one at a time, so an
 * unforeseen token parameter can never leak through the error path.
 */
export function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        return u.origin + u.pathname + (u.search ? '?<redacted>' : '');
    } catch {
        return url.split('?')[0];
    }
}

/**
 * Scrubs a raw download URL and its extracted token secrets out of an error
 * message string. Used when a download failure's exception text embeds the raw
 * URL verbatim; scrubbing each known token value too is belt-and-suspenders
 * against a downstream library (e.g. tool-lib's own partial `sig=` redaction)
 * embedding a differently-transformed copy of the URL.
 */
export function scrubSecretsFromMessage(message: string, url: string, secrets: string[]): string {
    const safeUrl = redactUrl(url);
    let safeMessage = message.split(url).join(safeUrl);
    for (const secret of secrets) {
        safeMessage = safeMessage.split(secret).join('<redacted>');
    }
    return safeMessage;
}

/**
 * Reads the raw `user:password` userinfo substring from a URL string (everything
 * between `://` and the last `@` of the authority), or null when the URL has no
 * authority at all. Operates on the raw string — not a parsed URL — so the exact
 * bytes a logger would print are what gets extracted and masked. The authority is
 * bounded by the first `/`, `?` or `#`; the userinfo/host split uses the LAST `@`
 * within it, matching the WHATWG URL parser and covering an `@` embedded in the
 * password.
 */
function rawUserInfo(url: string): string | null {
    const schemeIdx = url.indexOf('://');
    if (schemeIdx === -1) return null;
    const authorityStart = schemeIdx + 3;
    const rest = url.slice(authorityStart);
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const at = authority.lastIndexOf('@');
    if (at === -1) return null;
    return authority.slice(0, at);
}

/**
 * Extracts the credential material embedded in a URL's userinfo (the
 * `user:password@` component of `https://user:password@host/...`). Operator inputs
 * like registryUrl/mirrorBaseUrl/mirrorUrl can carry basic-auth userinfo for
 * internal artifact proxies; these values must be tasks.setSecret()'d before the
 * URL is echoed into a pipeline variable, the console, or an error message.
 *
 * Returns the full `user:password` credential substring plus, when a password is
 * present, the password on its own — each in both its raw (as-it-appears) and
 * percent-decoded forms, so every representation an agent might log is masked. A
 * benign username is NOT masked on its own when a password is present (masking the
 * specific `user:password` pair avoids over-redacting a common username like
 * `admin`); a lone userinfo with no `:` is treated as a token and masked whole.
 * Empty when the URL has no userinfo.
 */
export function extractUrlUserInfoSecrets(url: string): string[] {
    const userInfo = rawUserInfo(url);
    if (!userInfo) return [];
    const secrets: string[] = [];
    const pushWithDecoded = (raw: string): void => {
        if (!raw) return;
        secrets.push(raw);
        let decoded: string;
        try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
        if (decoded !== raw && decoded) secrets.push(decoded);
    };
    // Always mask the whole credential substring (specific enough not to collide
    // with unrelated log text). Also mask the password alone when present.
    pushWithDecoded(userInfo);
    const colon = userInfo.indexOf(':');
    if (colon !== -1) {
        pushWithDecoded(userInfo.slice(colon + 1));
    }
    return secrets;
}

/**
 * Strips the userinfo (`user:password@`) from a URL so it can be safely echoed
 * into a pipeline variable, the console, or an error message. Unlike redactUrl
 * (which drops the entire query string to kill a pre-signed token), this preserves
 * scheme, host, port, path and query — an operator-supplied registry/mirror URL
 * carries its credential only in the userinfo, and keeping the rest lets the
 * operator still see WHICH registry/mirror was used. Returns the input unchanged
 * when there is no userinfo to strip.
 */
export function redactUrlUserInfo(url: string): string {
    const userInfo = rawUserInfo(url);
    if (userInfo === null) return url;
    const authorityStart = url.indexOf('://') + 3;
    // authorityStart + userInfo.length points at the delimiting '@'; +1 drops it.
    return url.slice(0, authorityStart) + url.slice(authorityStart + userInfo.length + 1);
}
