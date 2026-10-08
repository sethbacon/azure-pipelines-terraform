import { assertPlainUrlBase } from '@4cloudguru/pipeline-task-core';

export interface ProviderMirrorConfig {
    mirrorUrl: string;
    allowDirectFallback: boolean;
    directExcludePatterns: string[];
    directIncludePatterns: string[];
    // Optional so pre-#960 config literals keep compiling unchanged; index.ts always supplies [].
    mirrorExcludePatterns?: string[];
    mirrorIncludePatterns?: string[];
    // #1231: opts back in to a direct block that overlaps the mirror. False when
    // omitted, so the overlap-free file is what every caller gets unless it asks.
    allowDirectForMirroredProviders?: boolean;
}

export interface InstallationPatterns {
    include: string[];
    exclude: string[];
}

export function validateMirrorUrl(url: string): void {
    if (!url) {
        throw new Error('Mirror URL is required');
    }
    // Terraform appends `/<hostname>/<namespace>/<type>/index.json` to this
    // value when it consults the network mirror, so it is a base a path is
    // concatenated onto: a query string or fragment in it would silently
    // retarget every provider lookup while the host stays the same. The shared
    // guard (azure-pipelines-terraform#1110 finding 2, the class fix across both
    // extensions) enforces https and rejects '?' / '#'; userinfo stays allowed
    // because an internal mirror behind basic auth is a documented pattern here
    // (masked and redacted before any log line, see index.ts).
    assertPlainUrlBase('mirrorUrl', url, 'allow');
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

// Terraform accepts both include and exclude on one installation method and lets
// exclude win on overlap (#872); emitting only one silently discards the other list.
function formatIncludeExclude(includePatterns: string[], excludePatterns: string[]): string {
    let lines = '';
    if (includePatterns.length > 0) {
        const formatted = includePatterns.map(p => `"${escapeHclString(p)}"`).join(', ');
        lines += `    include = [${formatted}]\n`;
    }
    if (excludePatterns.length > 0) {
        const formatted = excludePatterns.map(p => `"${escapeHclString(p)}"`).join(', ');
        lines += `    exclude = [${formatted}]\n`;
    }
    return lines;
}

// A provider pattern as Terraform's ParseMultiSourceMatchingPatterns reads it:
// [hostname, namespace, type], a two-segment pattern meaning registry.terraform.io,
// compared in lower case. undefined for a segment count Terraform rejects; such a
// pattern is still written wherever it was given, so `terraform init` reports it.
function parseProviderPattern(pattern: string): string[] | undefined {
    const segments = pattern.toLowerCase().split('/');
    if (segments.length === 2) {
        return ['registry.terraform.io', ...segments];
    }
    return segments.length === 3 ? segments : undefined;
}

// True when every provider `inner` matches is also matched by `outer`.
function covers(outer: string, inner: string): boolean {
    const outerSegments = parseProviderPattern(outer);
    const innerSegments = parseProviderPattern(inner);
    return outerSegments !== undefined && innerSegments !== undefined
        && outerSegments.every((segment, i) => segment === '*' || segment === innerSegments[i]);
}

function uniquePatterns(patterns: string[]): string[] {
    const seen = new Set<string>();
    return patterns.filter(pattern => {
        const key = (parseProviderPattern(pattern) ?? [pattern]).join('/');
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

// The providers both lists match. Terraform's patterns nest -- a wildcard type,
// then namespace, then hostname -- so two patterns that share a provider are one
// inside the other, and the narrower of the two is what they share.
function intersectPatterns(first: string[], second: string[]): string[] {
    const within = (list: string[]) => (pattern: string) => list.some(other => covers(other, pattern));
    return uniquePatterns([...first.filter(within(second)), ...second.filter(within(first))]);
}

/**
 * The direct blocks to write beside the mirror (#1231).
 *
 * Terraform takes the union of the versions reported by every installation
 * method that matches a provider, selects the newest, and then asks the methods
 * in the order written to supply it. A network mirror answering 404 for a
 * version it never listed is a query error, not "not found", so Terraform stops
 * there instead of moving on to direct (hashicorp/terraform#39104). A direct
 * block that overlaps the mirror is therefore never a fallback: it only adds
 * version numbers the mirror is then required to serve.
 *
 * So direct is confined to the providers the mirror does not match -- those
 * outside mirrorIncludePatterns, and those in mirrorExcludePatterns -- narrowed
 * by the direct patterns. Within one block exclude wins over include, so the two
 * ways out of the mirror cannot share a block; Terraform accepts any number of
 * blocks of one method.
 */
export function resolveDirectBlocks(config: ProviderMirrorConfig): InstallationPatterns[] {
    if (!config.allowDirectFallback) {
        return [];
    }
    const directInclude = config.directIncludePatterns;
    const directExclude = config.directExcludePatterns;
    if (config.allowDirectForMirroredProviders) {
        return [{ include: directInclude, exclude: directExclude }];
    }

    const mirrorInclude = config.mirrorIncludePatterns ?? [];
    const mirrorExclude = config.mirrorExcludePatterns ?? [];
    const blocks: InstallationPatterns[] = [];

    if (mirrorInclude.length > 0) {
        // A direct-include entry wholly inside the mirror is dropped, and with none
        // left there is no block: an empty include list would match every provider.
        const include = directInclude.filter(pattern => !mirrorInclude.some(mirrored => covers(mirrored, pattern)));
        if (directInclude.length === 0 || include.length > 0) {
            blocks.push({ include, exclude: uniquePatterns([...directExclude, ...mirrorInclude]) });
        }
    }

    if (mirrorExclude.length > 0) {
        const include = directInclude.length === 0 ? mirrorExclude : intersectPatterns(mirrorExclude, directInclude);
        if (include.length > 0) {
            blocks.push({ include, exclude: directExclude });
        }
    }

    return blocks;
}

/**
 * The directIncludePatterns entries that send nothing to direct, because every
 * provider they match is one the mirror serves (#1231, and #960 before it).
 */
export function directIncludesServedByMirror(config: ProviderMirrorConfig): string[] {
    if (!config.allowDirectFallback) {
        return [];
    }
    const written = resolveDirectBlocks(config).reduce<string[]>((all, block) => all.concat(block.include), []);
    return config.directIncludePatterns.filter(
        pattern => !written.some(included => included === pattern || covers(pattern, included))
    );
}

export function generateProviderInstallationConfig(config: ProviderMirrorConfig): string {
    const mirrorUrl = config.mirrorUrl.replace(/\/+$/, '');

    let hcl = 'provider_installation {\n';
    hcl += '  network_mirror {\n';
    hcl += `    url = "${escapeHclString(mirrorUrl)}/"\n`;
    // #960: without these, network_mirror matches every provider unconditionally and a
    // directIncludePatterns override can never actually bypass it.
    hcl += formatIncludeExclude(config.mirrorIncludePatterns ?? [], config.mirrorExcludePatterns ?? []);
    hcl += '  }\n';

    for (const block of resolveDirectBlocks(config)) {
        hcl += '  direct {\n';
        hcl += formatIncludeExclude(block.include, block.exclude);
        hcl += '  }\n';
    }

    hcl += '}\n';
    return hcl;
}
