/**
 * The hashing, platform and cache-integrity primitives shared by the three
 * installer tasks (TerraformInstallerV1, PolicyAgentInstallerV1,
 * TerraformDocsInstallerV1).
 *
 * Kept byte-identical across all three tasks' `src/` directories and guarded by
 * scripts/check-shared-modules.js. Each of these bodies was previously
 * hand-duplicated in every installer with identical content (#996) -- the same
 * drift risk #681 named for the version resolver, on the download-verification
 * path, where a correction landing in one installer and missed in the other two
 * is a security difference rather than a cosmetic one.
 *
 * Neither parity gate could see that duplication while it lived inline:
 * check-shared-modules.js only compares files named in FAMILIES, and
 * check-near-duplicate-modules.js groups candidates by BASENAME, so bodies
 * sitting in terraform-installer.ts, policy-agent-installer.ts and
 * terraform-docs-installer.ts were never compared to one another. Extracting
 * them into one same-named module is what brings them into reach of both.
 *
 * writeCacheIntegrityMarker and verifyCachedTool moved in last (#998):
 * scripts/check-artifact-trust.js used to classify a CACHE-ADMIT site by
 * resolving the call graph within a single file, so moving this pair out on its
 * own would have made every cache-admission site in the three callers report
 * TRUSTS-CACHE-BLINDLY even though the re-verification still happens. That gate
 * now follows same-directory `import`s (see its own header comment), so the pair
 * can live here with the primitives it is built on.
 */

import tasks = require('azure-pipelines-task-lib/task');
import os = require('os');
import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import { pipeline } from 'stream/promises';
import { VerificationFailure } from '@4cloudguru/pipeline-task-core';

// File name of the local, per-cached-tool-directory integrity marker written after
// a verified download (see writeCacheIntegrityMarker / verifyCachedTool below).
const CACHE_INTEGRITY_MARKER = ".installer-verified.sha256";

// A marker's content must be exactly one 64-character SHA256 digest. Anything else --
// empty, truncated, or non-hex -- means the marker is UNVERIFIABLE, not that the tool
// was tampered with; see verifyCachedTool (#198).
const CACHE_INTEGRITY_MARKER_PATTERN = /^[a-fA-F0-9]{64}$/;

export function getPlatformString(): string {
    switch (os.type()) {
        case "Darwin": return "darwin";
        case "Linux": return "linux";
        case "Windows_NT": return "windows";
        default: throw new Error(tasks.loc("OperatingSystemNotSupported", os.type()));
    }
}

export async function computeSha256Streaming(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

export async function hashFile(filePath: string): Promise<string> {
    return computeSha256Streaming(filePath);
}

export async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const actualHash = await computeSha256Streaming(filePath);
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new VerificationFailure(tasks.loc("Sha256VerificationFailed", expectedHash, actualHash));
    }
    tasks.debug(`SHA256 verification passed: ${actualHash}`);
}

/**
 * Writes a local integrity marker recording the SHA256 of the just-verified,
 * just-cached executable, so a later job's cache hit for the same tool/version can
 * re-verify it (see verifyCachedTool) without re-downloading anything. Best-effort:
 * a write failure must never fail an install that has already been verified — it
 * only means a future cache hit for this tool degrades to the pre-existing
 * trust-the-cache behavior.
 */
export async function writeCacheIntegrityMarker(toolDir: string, exePath: string): Promise<void> {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    // ATOMIC: write to a temp name in the SAME directory, then rename into place. A
    // plain writeFileSync interrupted mid-write -- agent disk full, job cancellation,
    // a container kill -- leaves a marker that exists and is readable but is empty or
    // truncated, and every later install of that version then compares the real digest
    // against that fragment and fails with a tampering-shaped CachedToolVerificationFailed,
    // permanently bricking the version on that agent (#198). Renaming into place means
    // a reader only ever sees a complete digest or no marker at all.
    const tempPath = `${markerPath}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(tempPath, await hashFile(exePath), 'utf8');
        fs.renameSync(tempPath, markerPath);
    } catch (err) {
        tasks.debug(`Could not write cache integrity marker for ${toolDir}: ${err instanceof Error ? err.message : err}`);
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
}

/**
 * On a tool-cache hit, re-verifies the cached executable against the local
 * integrity marker written when it was originally downloaded and verified. This is
 * a purely local, offline comparison (no network call), so it can never break
 * offline/air-gapped cache usage.
 *
 * - No marker (cached before this check existed, or cached by a run where checksum
 *   verification was disabled): returns false — the caller escalates to a remote
 *   re-verification against a freshly downloaded release (see
 *   reverifyUnmarkedCacheEntry), closing the cross-job trust-on-first-use gap.
 * - Marker present but MALFORMED — empty, truncated, or not 64 hex characters, i.e.
 *   an interrupted write (#198): returns false, exactly like a missing marker. An
 *   unverifiable record is not evidence of tampering; feeding the fragment to the
 *   comparison would fail every subsequent install of that version with a
 *   tampering-shaped error and send an operator down a security-incident path for
 *   what is a torn file. The marker is NOT healed here — healing happens only after
 *   the escalated re-verification actually proves the cached executable.
 * - Marker present and it matches the cached executable's current hash: passes
 *   silently, returns true.
 * - Marker present, well-formed, and it does not match: the cached executable changed
 *   since it was verified (tampering or corruption on a shared agent) — fail closed.
 *
 * Trust-boundary note: the marker lives next to the executable it protects, so an
 * attacker who can rewrite the cached binary under the agent account can rewrite
 * the marker to match. This check is defense-in-depth against corruption and
 * cross-job verification-policy mixing, not against an attacker who already has
 * write access to the agent's tool cache (who effectively owns the agent).
 */
export async function verifyCachedTool(toolDir: string, exePath: string, toolLabel: string): Promise<boolean> {
    const markerPath = path.join(toolDir, CACHE_INTEGRITY_MARKER);
    if (!fs.existsSync(markerPath)) {
        tasks.debug(`Cache hit for ${toolLabel}: no stored integrity marker found (cached before this check existed, or without checksum verification).`);
        return false;
    }
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim().toLowerCase();
    if (!CACHE_INTEGRITY_MARKER_PATTERN.test(storedHash)) {
        tasks.debug(`Cache hit for ${toolLabel}: the stored integrity marker is not a 64-character SHA256 digest (${storedHash.length} character(s) recorded); treating the entry as unverifiable rather than tampered.`);
        return false;
    }
    const actualHash = (await hashFile(exePath)).toLowerCase();
    if (actualHash !== storedHash) {
        throw new Error(tasks.loc("CachedToolVerificationFailed", toolLabel, storedHash, actualHash));
    }
    tasks.debug(`Cache hit for ${toolLabel}: integrity marker verified (${actualHash}).`);
    return true;
}
