/**
 * The pinned sigstore/cosign release, and the per-platform SHA256 digest of each
 * release asset the task-managed cosign install is allowed to use (#1027/#1118).
 *
 * WHY THIS FILE EXISTS. OpenTofu's only authenticity anchor in this extension is
 * the external `cosign` binary. Resolving it from the agent's ambient PATH means
 * `requireCosignVerification: true` -- the shipped default -- can be satisfied by
 * anything named `cosign` that exits 0, so a prior or concurrent job on a
 * persistent agent with PATH write access converts a default-on cryptographic
 * control into a no-op while the log still reports success. A verifier the task
 * installed and hashed ITSELF is the only form of that control that verifies
 * something; this table is what "hashed itself" means.
 *
 * PROVENANCE OF THESE DIGESTS -- DO NOT HAND-EDIT, RE-FETCH.
 *   source file: https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign_checksums.txt
 *   release tag: v3.1.3   (published 2026-08-06)
 *   fetched:     2026-09-08 (verbatim, via curl; the six entries below are copied
 *                unmodified from that file's `cosign-<os>-<arch>[.exe]` rows)
 *
 * Every digest below is the digest of the RAW RELEASE ASSET as published --
 * cosign ships the executable itself, not an archive, so the file this task
 * downloads is the file this table names.
 *
 * ROTATION. `.github/workflows/weekly-security.yml`'s `cosign-pin-freshness` job
 * compares COSIGN_PINNED_TAG with the current sigstore/cosign release every week
 * and fails (opening an issue) once the pin is more than
 * COSIGN_PIN_MAX_MINORS_BEHIND minor releases or COSIGN_PIN_MAX_DAYS_BEHIND days
 * behind. Rotating the pin means re-fetching the URL above and replacing the tag,
 * version, release date AND all six digests together -- a partial edit produces a
 * table that verifies nothing on the platforms it was not updated for.
 *
 * Deliberately dependency-free (no azure-pipelines-task-lib, no node built-ins
 * beyond none at all): it is a data table plus two pure lookups, so its unit test
 * and the freshness job can both load it without an agent.
 */

/** The pinned sigstore/cosign release tag, exactly as it appears in the download URL. */
export const COSIGN_PINNED_TAG = 'v3.1.3';

/** The same release without the leading `v` -- the tool-cache version key. */
export const COSIGN_PINNED_VERSION = '3.1.3';

/** Publication date (UTC) of COSIGN_PINNED_TAG, as reported by the GitHub releases API. */
export const COSIGN_PINNED_RELEASE_DATE = '2026-08-06';

/** Staleness budget enforced by the weekly `cosign-pin-freshness` job. */
export const COSIGN_PIN_MAX_MINORS_BEHIND = 2;
export const COSIGN_PIN_MAX_DAYS_BEHIND = 120;

/**
 * SHA256 of every `cosign-<os>-<arch>` asset published for COSIGN_PINNED_TAG that
 * this task can ever ask for -- copied verbatim from the `cosign_checksums.txt`
 * named in the header.
 *
 * sigstore publishes no `cosign-linux-386`, no `cosign-darwin-arm`, and no
 * Windows asset other than amd64, so those platform/arch combinations have no
 * entry and resolveCosignPin() returns undefined for them: the caller must fail
 * closed or be told to opt into `cosignSource: ambient`, never silently fall back
 * to PATH.
 *
 * A Map, not an object literal, because it is read by a COMPUTED key -- the #884
 * prototype-chain class. An object literal indexed by cosignAssetName()'s result
 * would resolve an inherited Object.prototype member instead of missing, and the
 * `sha256 ? ... : undefined` not-found branch below would never fire. Today's key
 * charset makes that unreachable, but the structural immunity costs nothing and
 * is what the rest of this repository's lookup tables already use.
 */
const COSIGN_ASSET_SHA256: ReadonlyMap<string, string> = new Map([
    ['cosign-darwin-amd64', '2347488e5d5b25336644024dfeca5601b190e91197a71a917bda44744aff106c'],
    ['cosign-darwin-arm64', '5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76'],
    ['cosign-linux-amd64', '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71'],
    ['cosign-linux-arm', '3275e61b43a45aa56a6242b49475d8a01874a07469c08fc32d027ba554996e4c'],
    ['cosign-linux-arm64', 'c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a'],
    ['cosign-windows-amd64.exe', '9fe59be0eca1271873ce019061335eb1ac419b7059202e797828467ddabe33be'],
]);

export interface CosignPin {
    /** The release-asset file name, which is also the cached executable's name. */
    assetName: string;
    /** Lower-case hex SHA256 the downloaded asset must match. */
    sha256: string;
}

/**
 * Maps a Node `os.arch()` value onto cosign's own release-asset architecture
 * token. Deliberately separate from terraform-installer.ts's getArchString():
 * that one names HashiCorp/OpenTofu archive architectures, and importing it here
 * would make cosign-verifier.ts <-> terraform-installer.ts a require cycle. The
 * two vocabularies agreeing today is a coincidence this file must not depend on.
 */
export function cosignArchToken(nodeArch: string): string | undefined {
    switch (nodeArch) {
        case 'x64': return 'amd64';
        case 'arm64': return 'arm64';
        case 'arm': return 'arm';
        default: return undefined;
    }
}

/**
 * The asset name cosign publishes for a platform/arch pair, in cosign's naming
 * (`cosign-<os>-<arch>`, with `.exe` on Windows). `platform` is the value
 * getPlatformString() produces: darwin | linux | windows.
 */
export function cosignAssetName(platform: string, nodeArch: string): string | undefined {
    const arch = cosignArchToken(nodeArch);
    if (!arch) return undefined;
    return platform === 'windows' ? `cosign-windows-${arch}.exe` : `cosign-${platform}-${arch}`;
}

/**
 * The pinned asset + digest for this agent, or undefined when the pinned release
 * publishes nothing for it. Returning undefined rather than throwing keeps this
 * module free of the task-lib error types; the caller decides how to fail.
 */
export function resolveCosignPin(platform: string, nodeArch: string): CosignPin | undefined {
    const assetName = cosignAssetName(platform, nodeArch);
    if (!assetName) return undefined;
    const sha256 = COSIGN_ASSET_SHA256.get(assetName);
    return sha256 ? { assetName, sha256 } : undefined;
}

/** Every (assetName, sha256) pair in the pinned table -- the freshness/table tests read this. */
export function cosignPinnedAssets(): ReadonlyArray<CosignPin> {
    return [...COSIGN_ASSET_SHA256].map(([assetName, sha256]) => ({ assetName, sha256 }));
}
