import dns = require('node:dns');

/**
 * Replaces the process-wide DNS resolver with a fixed zone, so a mock-runner
 * fixture can exercise the #588 TLS-opt-out destination guard
 * (assertTlsOptOutDestinationIsPrivate in @4cloudguru/pipeline-task-core)
 * without a live lookup.
 *
 * The guard classifies a NAME by the address it resolves to, so the interesting
 * rows -- a rooted public FQDN, a private registry whose name merely looks
 * public -- cannot be expressed with IP literals alone. A real lookup would
 * make those rows depend on the runner's network and on whoever owns the name;
 * a fixed zone makes the assertion about the guard.
 *
 * The package reads `dns.promises.lookup` at call time, so assigning it here
 * (before tr.run() requires the task) is seen by the guard. A name absent from
 * the zone raises ENOTFOUND, exactly as a real resolver would.
 */
export function stubDnsZone(zone: Record<string, string[]>): void {
    (dns.promises as unknown as { lookup: unknown }).lookup = async (host: string) => {
        const addresses = zone[host];
        if (!addresses) {
            const error = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
            error.code = 'ENOTFOUND';
            throw error;
        }
        return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
}

/** The zone every #588 destination fixture shares, so the rows mean the same thing in both tasks. */
export const TLS_OPT_OUT_ZONE: Record<string, string[]> = {
    // Real public registry endpoints: the destinations skipTlsVerify must never
    // be honoured against, in either the rooted or the unrooted spelling.
    'app.terraform.io': ['75.2.98.97'],
    'registry.terraform.io': ['104.16.4.1'],
    'terraform.io': ['76.76.21.21'],
    // An ordinary public host with no relationship to terraform.io: the half of
    // the class the old two-entry denylist never covered at all.
    'registry.public.example': ['93.184.216.34'],
    // Legitimate internal endpoints, including one whose NAME contains
    // "terraform.io" but which resolves into RFC1918 space.
    'registry.internal': ['10.4.5.6'],
    'my-terraform.io.internal.corp': ['10.9.9.9'],
    'registry.example.com': ['10.7.7.7'],
    'tsm.internal': ['172.16.9.9'],
    'tsm.example.com': ['10.8.8.8'],
};
