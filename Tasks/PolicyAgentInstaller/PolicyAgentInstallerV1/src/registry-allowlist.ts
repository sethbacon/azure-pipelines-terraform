// Registry/mirror EGRESS-AUTHORIZATION module. Duplicated byte-identically
// across the installer tasks and enforced by scripts/check-shared-modules.js —
// a fix to the matching logic must be applied to every copy or CI fails.
//
// assertEgressHostAllowed() is the single authorization decision every download
// destination goes through (initial URL AND every redirect hop). The address
// classification below is NUMERIC, not textual: hosts are parsed into real
// IPv4/IPv6 addresses in every legal spelling before being range-checked (#161).
//
// Also duplicated (body-identical, different provenance header) into the sibling
// azure-pipelines-packer extension's PackerInstallerV1/src — apply fixes there too.
import dns = require('dns');

/**
 * One DNS label. Underscores are permitted deliberately: this validates the
 * operator's PATTERN for obvious nonsense, it does not police DNS legality, and
 * underscore-bearing labels occur in real internal zones that the exact-match
 * arm below can legitimately pin.
 */
const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

/**
 * Rejects an allowlist entry that cannot mean what the operator intended,
 * rather than carrying it as a pin that silently matches nothing
 * (`example.com*`) or spans an entire public suffix (`*.com`). This is the
 * operator's only control over a compromised registry, so an unparseable pin
 * fails the task instead of degrading to a weaker allowlist (#888).
 *
 * Returns the entry in the form a runtime host is actually spelled.
 */
function assertValidAllowlistEntry(entry: string): string {
  const isWildcard = entry.startsWith('*.');
  const host = isWildcard ? entry.slice(2) : entry;
  const labels = host.split('.');
  const valid =
    host.length > 0 &&
    ((!isWildcard && isIpLiteral(host)) ||
      ((!isWildcard || labels.length >= 2) && labels.every(label => HOST_LABEL.test(label))));
  if (!valid) {
    throw new Error(
      `Invalid allowed-hosts entry '${entry}'. Expected a hostname such as ` +
        `'registry.example.com', an IP literal, or a single-label wildcard covering ` +
        `at least two labels such as '*.s3.amazonaws.com'.`,
    );
  }
  // A WHATWG URL always renders an IPv6 host bracketed, so an unbracketed IPv6
  // pin would validate here and then never equal a real request's hostname --
  // the silently-dead pin this validation exists to prevent.
  if (!isWildcard && !host.startsWith('[') && parseIpv6(bareHost(host)) !== null) {
    return `[${host}]`;
  }
  return entry;
}

/**
 * Parses a comma/newline-separated registryAllowedHosts input into a normalized
 * list, throwing on any entry that is not a valid hostname, IP literal or
 * wildcard.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\n,]/)
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0)
    .map(assertValidAllowlistEntry);
}

/**
 * Matches a download_url hostname against the allowlist. A `*.` prefix matches
 * EXACTLY ONE label — `*.s3.amazonaws.com` covers `bucket.s3.amazonaws.com` but
 * neither `a.bucket.s3.amazonaws.com` nor the bare `s3.amazonaws.com` — which is
 * the TLS wildcard-SAN semantics this control has always documented. A plain
 * suffix match silently widens an operator's corporate-domain pin to every
 * subdomain at any depth (#888).
 */
export function isRegistryHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some(allowed => {
    if (!allowed.startsWith('*.')) {
      return host === allowed;
    }
    const suffix = allowed.slice(1);
    if (!host.endsWith(suffix)) {
      return false;
    }
    const label = host.slice(0, host.length - suffix.length);
    return label.length > 0 && !label.includes('.');
  });
}

/**
 * Strips the decorations a WHATWG `URL.host`/`URL.hostname` (or an operator-typed
 * host) can carry — a bracketed IPv6 literal, an explicit port, an IPv6 zone id —
 * leaving the bare address/name the range checks below operate on.
 *
 * `URL.host` (unlike `.hostname`) includes an explicit non-default port, and
 * downloadToFile's per-redirect-hop callback is invoked with `.host`, so a redirect
 * Location like `https://10.0.0.5:8443/` would otherwise bypass every numeric check
 * (the parsers below are fully anchored and never match `address:port`). A BARE
 * (unbracketed) IPv6 address always has at least 2 colons — e.g. the loopback `::1`
 * that dns.lookup() returns verbatim — while a real `host:port` has exactly one, so
 * the port is only stripped when there is exactly one colon and the tail is digits.
 */
export function bareHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[')) {
    const closeBracket = host.indexOf(']');
    host = closeBracket >= 0 ? host.slice(1, closeBracket) : host.slice(1);
  } else {
    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 1) {
      const lastColon = host.lastIndexOf(':');
      if (/^\d+$/.test(host.slice(lastColon + 1))) {
        host = host.slice(0, lastColon);
      }
    }
  }
  // An IPv6 zone id (`fe80::1%eth0`) is not part of the address itself.
  const percent = host.indexOf('%');
  return percent >= 0 ? host.slice(0, percent) : host;
}

/**
 * Parses ONE dotted part of an IPv4 literal using inet_aton() radix rules, which
 * are what an OS resolver / TLS stack actually applies: `0x`-prefixed is hex,
 * a bare leading `0` is octal, everything else is decimal. Returns null for any
 * part that is empty or contains a digit outside its radix.
 *
 * This is the reason a purely TEXTUAL blocklist is the wrong shape: `127.1`,
 * `2130706433`, `0x7f000001` and `017700000001` are all 127.0.0.1 to the
 * connecting socket but match no dotted-quad regex.
 */
function parseIpv4Part(part: string): number | null {
  if (part.length === 0) {
    return null;
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    return Number.parseInt(part.slice(2), 16);
  }
  if (/^0[0-7]*$/.test(part)) {
    return Number.parseInt(part, 8);
  }
  if (/^[1-9][0-9]*$/.test(part)) {
    return Number.parseInt(part, 10);
  }
  return null;
}

/**
 * Parses an IPv4 literal in ANY of its legal spellings — dotted-quad, the
 * short forms (`a.b.c`, `a.b`, `a`) whose final part absorbs the remaining
 * octets, and hex/octal/decimal parts — into a single unsigned 32-bit address.
 * Returns null when `host` is not an IPv4 literal at all (a DNS name, an IPv6
 * literal, or an out-of-range spelling), so the caller can fall through to the
 * IPv6 parser and then to DNS resolution.
 */
export function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) {
    return null;
  }
  const values: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Part(part);
    if (value === null || !Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    values.push(value);
  }
  // Every part but the last is a single octet; the last absorbs the rest.
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 0xff) {
      return null;
    }
  }
  const tailBits = (5 - values.length) * 8;
  const tailMax = tailBits >= 32 ? 0xffffffff : Math.pow(2, tailBits) - 1;
  const tail = values[values.length - 1];
  if (tail > tailMax) {
    return null;
  }
  let address = tail;
  for (let i = 0; i < values.length - 1; i++) {
    address += values[i] * Math.pow(2, 8 * (3 - i));
  }
  return address >>> 0;
}

/**
 * Parses an IPv6 literal (full, `::`-compressed, or with a trailing embedded
 * IPv4 dotted-quad) into its eight 16-bit groups. Returns null when `host` is
 * not an IPv6 literal.
 */
export function parseIpv6(host: string): number[] | null {
  if (!host.includes(':')) {
    return null;
  }
  const doubleColon = host.indexOf('::');
  if (doubleColon !== host.lastIndexOf('::')) {
    return null;
  }
  const [headText, tailText] = doubleColon >= 0
    ? [host.slice(0, doubleColon), host.slice(doubleColon + 2)]
    : [host, null];

  const expand = (text: string, allowEmbeddedIpv4: boolean): number[] | null => {
    if (text === '') {
      return [];
    }
    const chunks = text.split(':');
    const groups: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;
      if (isLast && allowEmbeddedIpv4 && chunk.includes('.')) {
        // A trailing dotted-quad occupies the final two groups. Only the strict
        // dotted-quad spelling is legal inside an IPv6 literal.
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(chunk)) {
          return null;
        }
        const embedded = parseIpv4(chunk);
        if (embedded === null) {
          return null;
        }
        groups.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) {
        return null;
      }
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };

  const head = expand(headText, tailText === null);
  if (head === null) {
    return null;
  }
  if (tailText === null) {
    return head.length === 8 ? head : null;
  }
  const tail = expand(tailText, true);
  if (tail === null || head.length + tail.length > 7) {
    return null;
  }
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

/** [network, prefixLength] pairs, as unsigned 32-bit IPv4 addresses. */
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],  // 0.0.0.0/8        "this network"
  [0x0a000000, 8],  // 10.0.0.0/8       RFC1918
  [0x64400000, 10], // 100.64.0.0/10    RFC6598 carrier-grade NAT
  [0x7f000000, 8],  // 127.0.0.0/8      loopback
  [0xa9fe0000, 16], // 169.254.0.0/16   link-local, incl. cloud metadata (169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12    RFC1918
  [0xc0000000, 24], // 192.0.0.0/24     IETF protocol assignments
  [0xc0a80000, 16], // 192.168.0.0/16   RFC1918
  [0xc6120000, 15], // 198.18.0.0/15    RFC2544 benchmarking
  [0xe0000000, 4],  // 224.0.0.0/4      multicast
  [0xf0000000, 4],  // 240.0.0.0/4      reserved, incl. 255.255.255.255 broadcast
];

/** True when a 32-bit IPv4 address falls inside any non-public range above. */
export function isPrivateIpv4Address(address: number): boolean {
  return PRIVATE_IPV4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    // Both operands are coerced to int32 by `&`, so re-normalize to unsigned
    // before comparing: 172.16.0.0/12 and 169.254.0.0/16 both have the high bit
    // set and would otherwise compare as negative against a positive network.
    return (((address >>> 0) & mask) >>> 0) === network;
  });
}

/**
 * Extracts the IPv4 address embedded in an IPv6 group array for the transition
 * formats that put a routable-as-IPv4 destination inside an IPv6 literal, or
 * null when there is none: `::ffff:a.b.c.d` (IPv4-mapped — the form
 * `https://[::ffff:127.0.0.1]/` normalizes to and the one a textual blocklist
 * misses entirely), `::a.b.c.d` (IPv4-compatible), `64:ff9b::/96` (NAT64), and
 * `2002::/16` (6to4).
 */
function embeddedIpv4(groups: number[]): number | null {
  const low32 = (groups[6] * 0x10000 + groups[7]) >>> 0;
  const isZeroPrefix = groups.slice(0, 5).every(g => g === 0);
  if (isZeroPrefix && groups[5] === 0xffff) {
    return low32; // ::ffff:0:0/96 IPv4-mapped
  }
  if (isZeroPrefix && groups[5] === 0 && low32 !== 0 && low32 !== 1) {
    return low32; // ::/96 IPv4-compatible (:: and ::1 are handled separately)
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return low32; // 64:ff9b::/96 NAT64
  }
  if (groups[0] === 0x2002) {
    return ((groups[1] * 0x10000) + groups[2]) >>> 0; // 2002::/16 6to4
  }
  return null;
}

/** True when the eight-group IPv6 address is loopback/unspecified/ULA/link-local/multicast. */
function isPrivateIpv6Address(groups: number[]): boolean {
  if (groups.every(g => g === 0)) {
    return true; // ::
  }
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) {
    return true; // ::1
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((groups[0] & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }
  const embedded = embeddedIpv4(groups);
  return embedded !== null && isPrivateIpv4Address(embedded);
}

/**
 * Returns true when `hostname` denotes a loopback, link-local, carrier-grade-NAT,
 * RFC1918/ULA private, or otherwise non-public address — the common SSRF targets
 * (notably the cloud-provider instance-metadata service conventionally reachable
 * at 169.254.169.254) that a compromised or misconfigured registry/mirror could
 * steer a download toward even on the DEFAULT (allowlist unset) path.
 *
 * The classification is NUMERIC, not textual (#161): the host is first parsed
 * into an actual 32-bit IPv4 / 128-bit IPv6 address — accepting every legal
 * spelling an OS resolver accepts — and only then range-checked. A textual
 * dotted-quad blocklist is bypassed by `127.1`, `2130706433`, `0x7f000001`,
 * `017700000001` and `[::ffff:127.0.0.1]`, all of which connect to loopback,
 * and misses whole ranges (RFC6598 100.64.0.0/10) outright.
 *
 * A name that is not an IP literal at all returns false here; the caller pairs
 * this with resolvesToPrivateOrLinkLocalAddress (or assertEgressHostAllowed,
 * which does both) so a DNS name pointing at a private address is caught too.
 */
export function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  const ipv6 = parseIpv6(host);
  if (ipv6) {
    return isPrivateIpv6Address(ipv6);
  }
  const ipv4 = parseIpv4(host);
  return ipv4 !== null && isPrivateIpv4Address(ipv4);
}

/** True when `host` is an IP literal in any spelling (so DNS resolution would be pointless). */
export function isIpLiteral(host: string): boolean {
  const bare = bareHost(host);
  return parseIpv6(bare) !== null || parseIpv4(bare) !== null;
}

/**
 * Resolves `hostname` via DNS (all addresses) and returns true if ANY resolved
 * address is itself a non-public IP per isPrivateOrLinkLocalHost. That check
 * alone only catches a LITERAL IP address appearing directly in the URL; a
 * compromised or malicious registry/mirror can instead return an
 * ordinary-looking DNS name that resolves to a private/link-local address —
 * notably the cloud-provider instance-metadata service at 169.254.169.254 —
 * bypassing the literal check entirely.
 *
 * NOTE: this is a check-time resolution, not an IP pin — the subsequent
 * download re-resolves the hostname independently, so an attacker who controls
 * the host's authoritative DNS could still rebind to a private address between
 * this check and the connection. It is therefore defense-in-depth against the
 * static case, not a complete DNS-rebinding defense.
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
  const addresses = await lookup(bareHost(hostname));
  return addresses.some(a => isPrivateOrLinkLocalHost(a.address));
}

/** Caller-supplied, localized rejection text for assertEgressHostAllowed. */
export interface EgressHostMessages {
  /** Host is not in the operator's explicit allowlist. */
  notAllowed: (hostname: string, allowedHosts: string) => string;
  /** Host is (or resolves to) a private/link-local/reserved address on the default-deny path. */
  isPrivate: (hostname: string) => string;
}

/**
 * THE egress-authorization decision for a download destination. Every call site
 * — the initial URL AND every redirect hop — must route through this one
 * function rather than open-coding the allowlist/blocklist branches, which is
 * how the packer mirror path ended up re-checking only the textual blocklist
 * per hop while its initial check also resolved DNS (#161/#191).
 *
 * Semantics (unchanged from the open-coded form, minus the bypasses):
 *  - allowedHosts non-empty  -> the operator has explicitly pinned the trusted
 *    hosts, including a deliberately-private air-gapped mirror; only the pin is
 *    enforced, on every hop.
 *  - allowedHosts empty      -> default deny: refuse a host that IS a private/
 *    link-local/reserved address in any spelling, or that RESOLVES to one.
 *
 * Throws (never returns a bare boolean) so the rejection carries the call
 * site's own localized message naming the offending host.
 */
export async function assertEgressHostAllowed(
  hostname: string,
  allowedHosts: string[],
  messages: EgressHostMessages,
  lookup?: (host: string) => Promise<{ address: string }[]>,
): Promise<void> {
  if (allowedHosts.length > 0) {
    if (!isRegistryHostAllowed(hostname, allowedHosts)) {
      throw new Error(messages.notAllowed(hostname, allowedHosts.join(', ')));
    }
    return;
  }
  if (isPrivateOrLinkLocalHost(hostname)) {
    throw new Error(messages.isPrivate(hostname));
  }
  // An IP literal was already decided above; only a DNS name needs resolving.
  if (isIpLiteral(hostname)) {
    return;
  }
  if (await resolvesToPrivateOrLinkLocalAddress(hostname, lookup)) {
    throw new Error(messages.isPrivate(hostname));
  }
}
