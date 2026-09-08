import { describe, it } from 'mocha';
import assert = require('assert');
import {
    COSIGN_PINNED_TAG,
    COSIGN_PINNED_VERSION,
    COSIGN_PINNED_RELEASE_DATE,
    COSIGN_PIN_MAX_DAYS_BEHIND,
    COSIGN_PIN_MAX_MINORS_BEHIND,
    cosignArchToken,
    cosignAssetName,
    cosignPinnedAssets,
    resolveCosignPin,
} from '../src/cosign-pins';

/**
 * The shipped cosign digest table (#1027/#1118).
 *
 * The class test (ManagedVerifierResolutionL0) substitutes the digest, because no
 * offline test can produce a preimage of a real cosign release asset — so the REAL
 * table has to be asserted here instead, or the managed default would rest on a
 * value nothing checks. These rows assert the two properties an offline test can
 * establish about it: that every entry names an asset the pinned release actually
 * publishes under cosign's own naming scheme, and that every platform/arch this
 * task can run on either has an entry or is explicitly unrepresentable (in which
 * case the caller must fail closed rather than fall back to PATH).
 *
 * Freshness of the pin itself — is v3.1.3 still current? — is not knowable offline
 * either; `.github/workflows/weekly-security.yml`'s `cosign-pin-freshness` job owns
 * that, and the budget constants it enforces are asserted here so a silent widening
 * of the window shows up as a test change.
 */
describe('cosign pin table (#1027/#1118)', () => {
    // Every asset sigstore publishes for the pinned tag that this task can request,
    // with the platform/arch that must select it. `nodeArch` is an os.arch() value.
    const EXPECTED: Array<{ platform: string; nodeArch: string; assetName: string }> = [
        { platform: 'darwin', nodeArch: 'x64', assetName: 'cosign-darwin-amd64' },
        { platform: 'darwin', nodeArch: 'arm64', assetName: 'cosign-darwin-arm64' },
        { platform: 'linux', nodeArch: 'x64', assetName: 'cosign-linux-amd64' },
        { platform: 'linux', nodeArch: 'arm', assetName: 'cosign-linux-arm' },
        { platform: 'linux', nodeArch: 'arm64', assetName: 'cosign-linux-arm64' },
        { platform: 'windows', nodeArch: 'x64', assetName: 'cosign-windows-amd64.exe' },
    ];

    // Platform/arch pairs the pinned release publishes NOTHING for. Each must
    // resolve to undefined so resolveManagedCosign fails closed and names the
    // `cosignSource: ambient` opt-out, instead of silently reaching for PATH.
    const UNREPRESENTABLE: Array<{ platform: string; nodeArch: string; why: string }> = [
        { platform: 'linux', nodeArch: 'ia32', why: 'sigstore publishes no 386 cosign' },
        { platform: 'windows', nodeArch: 'arm64', why: 'sigstore publishes only cosign-windows-amd64.exe' },
        { platform: 'windows', nodeArch: 'arm', why: 'sigstore publishes only cosign-windows-amd64.exe' },
        { platform: 'darwin', nodeArch: 'arm', why: 'macOS has no 32-bit arm build' },
        { platform: 'linux', nodeArch: 'mips', why: 'not an architecture this task supports at all' },
    ];

    it('pins one release, and the tag and version agree', () => {
        assert.match(COSIGN_PINNED_VERSION, /^\d+\.\d+\.\d+$/);
        assert.strictEqual(COSIGN_PINNED_TAG, `v${COSIGN_PINNED_VERSION}`);
    });

    it('records the pinned release date so the weekly freshness job can measure drift', () => {
        assert.match(COSIGN_PINNED_RELEASE_DATE, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(!Number.isNaN(Date.parse(COSIGN_PINNED_RELEASE_DATE)), 'the pinned release date must parse');
        assert.ok(Date.parse(COSIGN_PINNED_RELEASE_DATE) <= Date.now(), 'the pinned release cannot be in the future');
    });

    it('keeps the staleness budget bounded', () => {
        assert.ok(COSIGN_PIN_MAX_MINORS_BEHIND >= 1 && COSIGN_PIN_MAX_MINORS_BEHIND <= 3, 'minor budget must stay tight');
        assert.ok(COSIGN_PIN_MAX_DAYS_BEHIND >= 30 && COSIGN_PIN_MAX_DAYS_BEHIND <= 180, 'day budget must stay tight');
    });

    it('contains exactly the assets the pinned release publishes for this task, and no others', () => {
        assert.deepStrictEqual(
            cosignPinnedAssets().map((p) => p.assetName).sort(),
            EXPECTED.map((e) => e.assetName).sort(),
            'the digest table and the pinned release asset list have diverged — re-fetch cosign_checksums.txt',
        );
    });

    for (const entry of cosignPinnedAssets()) {
        it(`${entry.assetName} carries a well-formed, distinct SHA256`, () => {
            assert.match(entry.sha256, /^[0-9a-f]{64}$/, 'digests must be lower-case 64-hex, copied verbatim from cosign_checksums.txt');
            const sameDigest = cosignPinnedAssets().filter((p) => p.sha256 === entry.sha256);
            assert.strictEqual(sameDigest.length, 1, `two assets share a digest (${sameDigest.map((p) => p.assetName).join(', ')}) — a copy/paste slip in the table`);
        });

        it(`${entry.assetName} is named the way sigstore names its release assets`, () => {
            assert.match(entry.assetName, /^cosign-(darwin|linux|windows)-(amd64|arm64|arm)(\.exe)?$/);
            assert.strictEqual(
                entry.assetName.endsWith('.exe'), entry.assetName.startsWith('cosign-windows-'),
                'only the Windows asset carries .exe',
            );
        });
    }

    for (const row of EXPECTED) {
        it(`${row.platform}/${row.nodeArch} resolves to ${row.assetName} with its pinned digest`, () => {
            assert.strictEqual(cosignAssetName(row.platform, row.nodeArch), row.assetName);
            const pin = resolveCosignPin(row.platform, row.nodeArch);
            assert.ok(pin, 'a supported platform must resolve to a pin');
            assert.strictEqual(pin.assetName, row.assetName);
            assert.match(pin.sha256, /^[0-9a-f]{64}$/);
        });
    }

    for (const row of UNREPRESENTABLE) {
        it(`${row.platform}/${row.nodeArch} resolves to no pin (${row.why})`, () => {
            assert.strictEqual(
                resolveCosignPin(row.platform, row.nodeArch), undefined,
                'an unrepresentable platform must yield no pin, so the caller fails closed instead of trusting PATH',
            );
        });
    }

    it('maps only the architectures cosign actually ships', () => {
        assert.strictEqual(cosignArchToken('x64'), 'amd64');
        assert.strictEqual(cosignArchToken('arm64'), 'arm64');
        assert.strictEqual(cosignArchToken('arm'), 'arm');
        assert.strictEqual(cosignArchToken('ia32'), undefined);
        assert.strictEqual(cosignArchToken('ppc64'), undefined);
    });
});
