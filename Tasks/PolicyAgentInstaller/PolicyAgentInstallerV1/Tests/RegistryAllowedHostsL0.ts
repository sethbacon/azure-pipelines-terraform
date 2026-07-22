import * as assert from 'assert';
import { parseAllowedHosts, isRegistryHostAllowed, resolvesToPrivateOrLinkLocalAddress } from '../src/registry-allowlist';

/**
 * Direct unit tests for the optional registry download_url host allowlist.
 * Ported from TerraformInstallerV1 — this installer implements the identical
 * parseAllowedHosts/isRegistryHostAllowed pair, so it must carry the same
 * coverage. The registry API response is partially attacker-influenced if the
 * registry is compromised (download_url is registry-controlled), and
 * tools.downloadTool follows redirects with no way to disable that — so an
 * operator who wants to pin the trusted storage host(s) can opt in via
 * registryAllowedHosts. Empty input preserves the trust-the-registry behavior.
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
});
