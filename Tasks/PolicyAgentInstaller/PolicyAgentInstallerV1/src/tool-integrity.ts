/**
 * The hashing and platform primitives shared by the three installer tasks
 * (TerraformInstallerV1, PolicyAgentInstallerV1, TerraformDocsInstallerV1):
 * computing an artifact's SHA256 and comparing it to a published checksum.
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
 * DELIBERATELY NOT HERE: writeCacheIntegrityMarker and verifyCachedTool, which
 * are byte-identical in all three installers too and by rights belong beside
 * these. They cannot move yet. scripts/check-artifact-trust.js classifies a
 * CACHE-ADMIT site by resolving the call graph WITHIN A SINGLE FILE -- its
 * `recordReaders` set is built from that file's own top-level functions, and the
 * 64-hex marker validator it looks for must be a module-scope const in that same
 * file. Moving the pair out makes all four cache-admission sites report
 * TRUSTS-CACHE-BLINDLY even though the re-verification still happens: that is,
 * de-duplicating them would blind the signature that guards them. Teaching that
 * gate to follow same-directory imports is its own change, tracked separately.
 */

import tasks = require('azure-pipelines-task-lib/task');
import os = require('os');
import fs = require('fs');
import crypto = require('crypto');
import { pipeline } from 'stream/promises';
import { VerificationFailure } from '@4cloudguru/pipeline-task-core';

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
