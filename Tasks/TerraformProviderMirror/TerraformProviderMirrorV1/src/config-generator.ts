export interface ProviderMirrorConfig {
    mirrorUrl: string;
    allowDirectFallback: boolean;
    directExcludePatterns: string[];
    directIncludePatterns: string[];
}

export function validateMirrorUrl(url: string): void {
    if (!url) {
        throw new Error('Mirror URL is required');
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid mirror URL: ${url}`);
    }

    if (parsed.protocol !== 'https:') {
        throw new Error(`Insecure URL rejected: ${url}. Only HTTPS URLs are allowed.`);
    }
}

/**
 * Escape a value for safe interpolation inside a double-quoted HCL string
 * literal. Without this, a mirror URL or include/exclude pattern containing a
 * `"` or a newline could break out of the quoted string and inject arbitrary
 * HCL into the generated .terraformrc. mirrorUrl is validated as a genuine
 * HTTPS URL via `new URL()` before reaching here, but that validation checks
 * the parsed representation, not the raw string that's actually interpolated
 * -- escaping it too is cheap defense-in-depth against a URL string crafted to
 * carry a literal quote/newline through validation. `${` and `%{` are also
 * escaped to their literal HCL forms (`$${` / `%%{`) so a value containing
 * template-interpolation or template-directive syntax is reproduced literally
 * instead of being evaluated by Terraform's HCL parser. The backslash escape
 * runs first so a raw `\` is doubled before any `$`/`%` escaping is applied;
 * since the `${`/`%{` replacements only ever touch `$`/`%`/`{` characters and
 * never introduce or consume a backslash, the two escaping passes can't
 * interfere with each other regardless of order (e.g. `\${` becomes `\\$${`,
 * which HCL decodes back to `\${`).
 */
function escapeHclString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$\{/g, () => '$${')
        .replace(/%\{/g, () => '%%{')
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\n');
}

export function generateProviderInstallationConfig(config: ProviderMirrorConfig): string {
    const mirrorUrl = config.mirrorUrl.replace(/\/+$/, '');

    let hcl = 'provider_installation {\n';
    hcl += '  network_mirror {\n';
    hcl += `    url = "${escapeHclString(mirrorUrl)}/"\n`;
    hcl += '  }\n';

    if (config.allowDirectFallback) {
        hcl += '  direct {\n';

        if (config.directIncludePatterns.length > 0) {
            const formatted = config.directIncludePatterns.map(p => `"${escapeHclString(p)}"`).join(', ');
            hcl += `    include = [${formatted}]\n`;
        } else if (config.directExcludePatterns.length > 0) {
            const formatted = config.directExcludePatterns.map(p => `"${escapeHclString(p)}"`).join(', ');
            hcl += `    exclude = [${formatted}]\n`;
        }

        hcl += '  }\n';
    }

    hcl += '}\n';
    return hcl;
}
