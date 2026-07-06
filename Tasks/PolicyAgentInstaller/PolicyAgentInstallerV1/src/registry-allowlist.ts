// Registry download-host allowlist. Duplicated byte-identically across the
// installer tasks and enforced by scripts/check-shared-modules.js — a fix to the
// matching logic must be applied to every copy or CI fails.

/** Parses a comma/newline-separated registryAllowedHosts input into a normalized list. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\n,]/)
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0);
}

/**
 * Matches a download_url hostname against the allowlist. A `*.` prefix on an
 * allowlist entry matches only its subdomains (not the bare host itself),
 * mirroring TLS wildcard-SAN semantics — useful for registry-controlled
 * storage hosts like *.s3.amazonaws.com.
 */
export function isRegistryHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some(allowed =>
    allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed,
  );
}
