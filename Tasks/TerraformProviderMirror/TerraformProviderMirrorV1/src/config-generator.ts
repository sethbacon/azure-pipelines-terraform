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

export function generateProviderInstallationConfig(config: ProviderMirrorConfig): string {
    const mirrorUrl = config.mirrorUrl.replace(/\/+$/, '');

    let hcl = 'provider_installation {\n';
    hcl += '  network_mirror {\n';
    hcl += `    url = "${mirrorUrl}/"\n`;
    hcl += '  }\n';

    if (config.allowDirectFallback) {
        hcl += '  direct {\n';

        if (config.directIncludePatterns.length > 0) {
            const formatted = config.directIncludePatterns.map(p => `"${p}"`).join(', ');
            hcl += `    include = [${formatted}]\n`;
        } else if (config.directExcludePatterns.length > 0) {
            const formatted = config.directExcludePatterns.map(p => `"${p}"`).join(', ');
            hcl += `    exclude = [${formatted}]\n`;
        }

        hcl += '  }\n';
    }

    hcl += '}\n';
    return hcl;
}
