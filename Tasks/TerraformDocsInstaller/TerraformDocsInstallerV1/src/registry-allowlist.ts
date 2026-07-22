// Registry download-host allowlist. Duplicated byte-identically across the
// installer tasks and enforced by scripts/check-shared-modules.js — a fix to the
// matching logic must be applied to every copy or CI fails.

import dns = require('dns');

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

/**
 * Returns true when `hostname` is a loopback, link-local, or RFC1918/ULA
 * private-range literal IP, or the `localhost` alias — the common SSRF
 * targets (notably the cloud-provider instance-metadata service conventionally
 * reachable at 169.254.169.254) that a compromised or misconfigured registry
 * could steer a download toward even on the DEFAULT (registryAllowedHosts
 * unset) path (#729). This is a baseline, always-on check on the initial
 * advertised host; it does not replace the stronger, explicit
 * registryAllowedHosts pin (which also re-validates every redirect hop) and is
 * only applied when the operator has NOT configured that pin, so an operator
 * who deliberately allowlists a private-IP mirror for an air-gapped
 * environment is unaffected.
 */
export function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 127 || // loopback
      a === 10 || // RFC1918
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 169 && b === 254) || // link-local, incl. cloud metadata services
      a === 0 // "this network"
    );
  }
  if (host === '::1' || host === '::') {
    return true;
  }
  // IPv6 link-local (fe80::/10) and unique local (fc00::/7).
  return /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
}

/**
 * Resolves `hostname` via DNS (all addresses) and returns true if ANY resolved
 * address is itself a loopback/link-local/private-range IP per
 * isPrivateOrLinkLocalHost. That check alone only catches a LITERAL IP address
 * appearing directly in the registry's download_url; a compromised or
 * malicious registry can instead return an ordinary-looking DNS name (e.g. an
 * attacker-controlled domain) that resolves to a private/link-local address —
 * notably the cloud-provider instance-metadata service at 169.254.169.254 —
 * bypassing that check entirely on the DEFAULT (registryAllowedHosts unset)
 * path (#769). This re-applies the same private/link-local test against every
 * address the host resolves to at check time, refusing the common static case
 * (a name that simply resolves to a private/metadata IP). NOTE: this is a
 * check-time resolution, not an IP pin — the subsequent download re-resolves
 * the hostname independently, so an attacker who controls the host's
 * authoritative DNS could still rebind to a private address between this check
 * and the connection. It is therefore defense-in-depth against the static
 * case, not a complete DNS-rebinding defense.
 *
 * `lookup` defaults to a real DNS resolution and is only overridden by tests.
 * A lookup failure (e.g. NXDOMAIN) is deliberately NOT caught here — it
 * propagates and fails the task exactly as an unresolvable host would fail
 * the download itself moments later, with an accurate DNS error rather than
 * a misleading "host is private" message.
 */
export async function resolvesToPrivateOrLinkLocalAddress(
  hostname: string,
  lookup: (host: string) => Promise<{ address: string }[]> = (host) => dns.promises.lookup(host, { all: true }),
): Promise<boolean> {
  const addresses = await lookup(hostname);
  return addresses.some(a => isPrivateOrLinkLocalHost(a.address));
}

