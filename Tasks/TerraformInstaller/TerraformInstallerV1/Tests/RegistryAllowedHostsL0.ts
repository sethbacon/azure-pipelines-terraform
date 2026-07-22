import * as assert from 'assert';
import { parseAllowedHosts, isRegistryHostAllowed, isPrivateOrLinkLocalHost, resolvesToPrivateOrLinkLocalAddress } from '../src/registry-allowlist';

/**
 * Direct unit tests for the optional registry download_url host allowlist.
 * The registry API response is partially attacker-influenced if the registry
 * is compromised (download_url is registry-controlled), and tools.downloadTool
 * follows redirects with no way to disable that — so an operator who wants to
 * pin the trusted storage host(s) can opt in via registryAllowedHosts. Empty
 * input preserves the existing trust-the-registry behavior.
 */
describe('registry download_url host allowlist', function () {
    describe('parseAllowedHosts', () => {
        it('returns an empty list for unset/empty input (no restriction)', () => {
            assert.deepStrictEqual(parseAllowedHosts(undefined), []);
            assert.deepStrictEqual(parseAllowedHosts(''), []);
        });

        it('splits on commas and newlines, trims, and lowercases', () => {
            assert.deepStrictEqual(
                parseAllowedHosts('Storage.Example.com, \n *.S3.amazonaws.com \n,, foo.bar'),
                ['storage.example.com', '*.s3.amazonaws.com', 'foo.bar'],
            );
        });
    });

    describe('isRegistryHostAllowed', () => {
        it('matches an exact host', () => {
            assert.strictEqual(isRegistryHostAllowed('storage.example.com', ['storage.example.com']), true);
            assert.strictEqual(isRegistryHostAllowed('other.example.com', ['storage.example.com']), false);
        });

        it('is case-insensitive', () => {
            assert.strictEqual(isRegistryHostAllowed('Storage.Example.com', ['storage.example.com']), true);
        });

        it('matches subdomains via a *. wildcard prefix, but not the bare host', () => {
            assert.strictEqual(isRegistryHostAllowed('mybucket.s3.amazonaws.com', ['*.s3.amazonaws.com']), true);
            assert.strictEqual(isRegistryHostAllowed('s3.amazonaws.com', ['*.s3.amazonaws.com']), false);
            assert.strictEqual(isRegistryHostAllowed('evil-s3.amazonaws.com', ['*.s3.amazonaws.com']), false);
        });

        it('rejects when the allowlist is non-empty and nothing matches', () => {
            assert.strictEqual(isRegistryHostAllowed('attacker.example.net', ['storage.example.com']), false);
        });
    });

    describe('resolvesToPrivateOrLinkLocalAddress', () => {
        it('returns true when the host resolves to a private/link-local address (#769)', async () => {
            const lookup = async () => [{ address: '169.254.169.254' }];
            assert.strictEqual(await resolvesToPrivateOrLinkLocalAddress('attacker.example.net', lookup), true);
        });

        it('returns false when every resolved address is public', async () => {
            const lookup = async () => [{ address: '93.184.216.34' }];
            assert.strictEqual(await resolvesToPrivateOrLinkLocalAddress('storage.example.com', lookup), false);
        });

        it('returns true when only one of several resolved addresses is private', async () => {
            const lookup = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
            assert.strictEqual(await resolvesToPrivateOrLinkLocalAddress('attacker.example.net', lookup), true);
        });

        it('checks an IPv6 private/link-local resolved address too', async () => {
            const lookup = async () => [{ address: 'fe80::1' }];
            assert.strictEqual(await resolvesToPrivateOrLinkLocalAddress('attacker.example.net', lookup), true);
        });

        it('propagates a lookup failure (e.g. NXDOMAIN) instead of misreporting it as private', async () => {
            const lookup = async () => { throw new Error('ENOTFOUND attacker.example.net'); };
            await assert.rejects(resolvesToPrivateOrLinkLocalAddress('attacker.example.net', lookup), /ENOTFOUND/);
        });
    });

    describe('isPrivateOrLinkLocalHost: port-suffix handling (#729 follow-up)', () => {
        it('still detects a bare private IPv4 address with no port', () => {
            assert.strictEqual(isPrivateOrLinkLocalHost('10.0.0.5'), true);
            assert.strictEqual(isPrivateOrLinkLocalHost('169.254.169.254'), true);
        });

        it('still returns false for a bare public IPv4 address with no port', () => {
            assert.strictEqual(isPrivateOrLinkLocalHost('93.184.216.34'), false);
        });

        it('detects a private IPv4 address with an explicit port (WHATWG URL.host shape)', () => {
            // downloadToFile's per-redirect-hop callback is invoked with URL.host,
            // which includes a non-default port -- a redirect straight to the
            // cloud metadata service on a non-default port must still be caught.
            assert.strictEqual(isPrivateOrLinkLocalHost('169.254.169.254:8443'), true);
            assert.strictEqual(isPrivateOrLinkLocalHost('10.0.0.5:443'), true);
        });

        it('does not treat a public IPv4 address with an explicit port as private', () => {
            assert.strictEqual(isPrivateOrLinkLocalHost('93.184.216.34:8443'), false);
        });

        it('detects a bracketed private IPv6 address with an explicit port', () => {
            assert.strictEqual(isPrivateOrLinkLocalHost('[::1]:8443'), true);
            assert.strictEqual(isPrivateOrLinkLocalHost('[fe80::1]:443'), true);
        });

        it('still detects a bracketed private IPv6 address with no port', () => {
            assert.strictEqual(isPrivateOrLinkLocalHost('[::1]'), true);
        });

        it('does not treat "localhost" with an explicit port as a non-match', () => {
            assert.strictEqual(isPrivateOrLinkLocalHost('localhost:8443'), true);
        });

        it('still detects a BARE (unbracketed, no port) IPv6 loopback/link-local address -- the shape dns.lookup() actually returns', () => {
            // Regression: an earlier version of the port-stripping fix used
            // hostname.lastIndexOf(':') unconditionally, which found the SECOND
            // colon in '::1', treated the trailing '1' as a "port", and sliced
            // the address down to ':' -- silently breaking the exact DNS-resolved
            // loopback shape resolvesToPrivateOrLinkLocalAddress depends on. A
            // bare IPv6 address always has >=2 colons, so port-stripping must
            // only fire when there is EXACTLY one.
            assert.strictEqual(isPrivateOrLinkLocalHost('::1'), true);
            assert.strictEqual(isPrivateOrLinkLocalHost('::'), true);
            assert.strictEqual(isPrivateOrLinkLocalHost('fe80::1'), true);
            assert.strictEqual(isPrivateOrLinkLocalHost('fc00::1'), true);
        });
    });
});
