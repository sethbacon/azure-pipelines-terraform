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
  let host = hostname.toLowerCase();
  // Strip an optional port suffix before the address checks below. WHATWG
  // URL.host (unlike .hostname) includes an explicit non-default port, and
  // downloadToFile's per-redirect-hop callback is invoked with .host -- so a
  // redirect Location like https://10.0.0.5:8443/ would otherwise bypass
  // every check below (the IPv4 regex is fully anchored and never matches a
  // 'digits.digits.digits.digits:port' string) (#729 follow-up). A bracketed
  // IPv6 literal (`[addr]` or `[addr]:port`) is unwrapped by locating the
  // matching `]` rather than assuming it is the final character.
  if (host.startsWith('[')) {
    const closeBracket = host.indexOf(']');
    host = closeBracket >= 0 ? host.slice(1, closeBracket) : host.slice(1);
  } else {
    // A BARE (unbracketed) IPv6 address always has at least 2 colons (the
    // '::' shorthand, or 2+ literal ':' separators between hextets) -- e.g.
    // the loopback '::1' returned verbatim by Node's dns.lookup(), which the
    // sibling resolvesToPrivateOrLinkLocalAddress check feeds in with no
    // brackets and no port at all. A REAL 'host:port'/'ipv4:port' string has
    // exactly ONE colon. Only strip when there is exactly one, so a bare
    // IPv6 literal (however many colons) is never misread as 'address:port'
    // and truncated into something that no longer matches the checks below.
    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 1) {
      const lastColon = host.lastIndexOf(':');
      if (/^\d+$/.test(host.slice(lastColon + 1))) {
        host = host.slice(0, lastColon);
      }
    }
  }
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

