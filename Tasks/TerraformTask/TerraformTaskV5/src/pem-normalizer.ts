import crypto = require('crypto');

/**
 * Normalize a PEM-encoded private key to standard format.
 *
 * Azure DevOps service connections often deliver PEM keys as a single line
 * with spaces instead of newlines.  This function:
 *   1. Extracts the PEM type label (e.g. "PRIVATE KEY", "RSA PRIVATE KEY").
 *   2. Strips all whitespace from the base64 body.
 *   3. Re-wraps at 64-character lines (RFC 7468 §2).
 *   4. Reassembles header, body, and footer with LF line endings.
 *   5. Validates the result with `crypto.createPrivateKey()`.
 *
 * Throws on malformed input (missing header/footer, invalid base64, or
 * a key that Node's crypto cannot parse).
 */
export function normalizePem(pem: string): string {
    const headerRe = /-----BEGIN ([A-Z0-9 ]+)-----/;
    const footerRe = /-----END ([A-Z0-9 ]+)-----/;

    const headerMatch = pem.match(headerRe);
    const footerMatch = pem.match(footerRe);

    if (!headerMatch || !footerMatch) {
        throw new Error('Invalid PEM: missing header or footer');
    }

    const label = headerMatch[1];
    if (headerMatch[1] !== footerMatch[1]) {
        throw new Error(`Invalid PEM: header label "${headerMatch[1]}" does not match footer label "${footerMatch[1]}"`);
    }

    // Extract base64 body between header and footer, strip all whitespace
    const afterHeader = pem.substring(pem.indexOf(headerMatch[0]) + headerMatch[0].length);
    const body = afterHeader.substring(0, afterHeader.indexOf(footerMatch[0]));
    const base64 = body.replace(/\s+/g, '');

    if (base64.length === 0) {
        throw new Error('Invalid PEM: empty key body');
    }

    // Validate base64 characters
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) {
        throw new Error('Invalid PEM: key body contains non-base64 characters');
    }

    // Re-wrap at 64-character lines per RFC 7468
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 64) {
        lines.push(base64.substring(i, i + 64));
    }

    const normalized = `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;

    // Validate the key can be parsed by Node's crypto
    try {
        crypto.createPrivateKey(normalized);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid PEM: crypto validation failed — ${message}`);
    }

    return normalized;
}
