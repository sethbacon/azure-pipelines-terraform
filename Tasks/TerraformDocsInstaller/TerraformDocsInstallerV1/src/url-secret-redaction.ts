/**
 * Registry-provided pre-signed download URLs (Azure blob SAS, AWS S3 presigned,
 * GCS signed URL) carry a live, short-TTL storage credential in their query
 * string. azure-pipelines-tool-lib's downloadTool logs the URL at INFO and only
 * auto-redacts Azure `sig=`, so AWS `X-Amz-Signature`/`X-Amz-Credential`/
 * `X-Amz-Security-Token` and GCS `X-Goog-Signature`/`X-Goog-Credential` would
 * otherwise print unredacted on every normal registry run — and the same token
 * can leak again if a download failure echoes the raw URL in its message.
 *
 * Shared byte-for-byte across all three installer tasks that consume a registry
 * download_url (guarded by scripts/check-shared-modules.js) so a fix here can
 * never be applied to one copy and silently missed in the others.
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
