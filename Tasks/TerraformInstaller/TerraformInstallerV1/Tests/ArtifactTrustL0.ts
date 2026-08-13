import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import { verifySha256, verifyCachedTool, writeCacheIntegrityMarker } from '../src/terraform-installer';
import { discardArtifactOnFailure } from '@4cloudguru/pipeline-task-core';
import { VerificationFailure } from '@4cloudguru/pipeline-task-core';

/**
 * CLASS TEST — artifact trust (#65 / #78 / #136 / #198 / #204), sibling of
 * azure-pipelines-packer's Tests/ArtifactTrustL0.ts.
 *
 * Defect class: an installed artifact is trusted without the verification the task
 * advertises, or the verification's failure/edge state leaves the install path
 * unrecoverable or silently degraded.
 *
 * Three tables:
 *   A. SITE_ROWS — every trust site the re-runnable signature
 *      (scripts/check-artifact-trust.js) enumerates across the WHOLE repo: all three
 *      installer tasks, not just this one. A new download strategy or cache path in
 *      any of them shows up here automatically and fails the enumeration assertion
 *      until it is accounted for.
 *   B. the failure/edge STATES themselves, driven through the real exported helpers:
 *      a checksum mismatch (the artifact must be gone), a zero-length / truncated /
 *      non-hex cache marker, a marker that matches, a marker that does not.
 *   C. the same states end-to-end through the task.
 *
 * Every row is mutation-provable: inverting the guard it exercises turns that row —
 * and only that row's group — RED.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const TF = 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts';
const PA = 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts';
const TD = 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts';

type SiteRow = { file: string; fn: string; kind: string; verdict: string };

/**
 * Table A. Grouped by task. `VERIFIED` acquisition + `DISCARDS-ON-FAILURE`
 * verification is the shape every fresh-download path must have; the EXEMPT verdicts
 * are the code-verified exceptions, each of which is a real difference in the source's
 * trust root (see the notes on the SUMS-ABSENT rows) rather than a hole.
 */
const SITE_ROWS: SiteRow[] = [
    // ---------------- TerraformInstallerV1: terraform (GPG) + OpenTofu (cosign) ----
    { file: TF, fn: 'downloadTerraform', kind: 'CACHE-ADMIT', verdict: 'REVERIFIES-AND-GATES' },
    { file: TF, fn: 'resolveVersionFromHashiCorp', kind: 'LATEST', verdict: 'FAILS-CLOSED' },
    { file: TF, fn: 'downloadZipFromHashiCorp', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: TF, fn: 'downloadZipFromHashiCorp', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TF, fn: 'downloadZipFromHashiCorp', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TF, fn: 'downloadZipFromRegistry', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: TF, fn: 'downloadZipFromRegistry', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TF, fn: 'downloadZipFromMirror', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    // The reported site of #65 in this repo: a mirror that publishes no SHA256SUMS
    // also publishes nothing for the .sig to sign, so requireGpgSignature is read on
    // that branch too.
    { file: TF, fn: 'downloadZipFromMirror', kind: 'SUMS-ABSENT', verdict: 'HONORS-SIGNATURE-TOGGLE' },
    { file: TF, fn: 'downloadZipFromMirror', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TF, fn: 'downloadZipFromMirror', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TF, fn: 'writeCacheIntegrityMarker', kind: 'RECORD-WRITE', verdict: 'ATOMIC-WRITE' },
    { file: TF, fn: 'verifyCachedTool', kind: 'RECORD-READ', verdict: 'VALIDATES-RECORD' },
    { file: TF, fn: 'downloadTofu', kind: 'CACHE-ADMIT', verdict: 'REVERIFIES-AND-GATES' },
    { file: TF, fn: 'resolveVersionFromOpenTofu', kind: 'LATEST', verdict: 'FAILS-CLOSED' },
    { file: TF, fn: 'downloadZipFromOpenTofu', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: TF, fn: 'downloadZipFromOpenTofu', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TF, fn: 'downloadZipFromOpenTofu', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },

    // ---------------- PolicyAgentInstallerV1: Sentinel (GPG) + OPA (sha256 only) ---
    { file: PA, fn: 'downloadPolicyAgent', kind: 'CACHE-ADMIT', verdict: 'REVERIFIES-AND-GATES' },
    { file: PA, fn: 'downloadSentinelOfficial', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: PA, fn: 'downloadSentinelOfficial', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: PA, fn: 'downloadSentinelOfficial', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: PA, fn: 'downloadOpaOfficial', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    // OPA ships no detached signature — its trust root is the sha256 published beside
    // the asset on the same GitHub release. There is no signature toggle to honor
    // here, and flattening this into the HashiCorp shape would invent one.
    { file: PA, fn: 'downloadOpaOfficial', kind: 'SUMS-ABSENT', verdict: 'EXEMPT-NO-SIGNATURE-TRUST-ROOT' },
    { file: PA, fn: 'downloadOpaOfficial', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: PA, fn: 'downloadFromRegistry', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: PA, fn: 'downloadFromRegistry', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: PA, fn: 'downloadFromMirror', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: PA, fn: 'downloadFromMirror', kind: 'SUMS-ABSENT', verdict: 'EXEMPT-NO-SIGNATURE-TRUST-ROOT' },
    { file: PA, fn: 'downloadFromMirror', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    // Sentinel IS GPG-rooted, so the same mirror branch that is exempt for OPA above
    // must honor requireGpgSignature here. Same file, two different trust roots.
    { file: PA, fn: 'verifyMirrorChecksum', kind: 'SUMS-ABSENT', verdict: 'HONORS-SIGNATURE-TOGGLE' },
    { file: PA, fn: 'verifyMirrorChecksum', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: PA, fn: 'verifyMirrorChecksum', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: PA, fn: 'downloadTo', kind: 'ACQUIRE', verdict: 'EXEMPT-DELEGATES-TO-CALLER' },
    { file: PA, fn: 'downloadFromMirrorUrl', kind: 'ACQUIRE', verdict: 'EXEMPT-DELEGATES-TO-CALLER' },
    { file: PA, fn: 'writeCacheIntegrityMarker', kind: 'RECORD-WRITE', verdict: 'ATOMIC-WRITE' },
    { file: PA, fn: 'verifyCachedTool', kind: 'RECORD-READ', verdict: 'VALIDATES-RECORD' },

    // ---------------- TerraformDocsInstallerV1: sha256 only, no signature ----------
    { file: TD, fn: 'downloadTerraformDocs', kind: 'CACHE-ADMIT', verdict: 'REVERIFIES-AND-GATES' },
    { file: TD, fn: 'downloadOfficial', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: TD, fn: 'downloadFromRegistry', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    { file: TD, fn: 'downloadFromRegistry', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TD, fn: 'downloadFromMirror', kind: 'ACQUIRE', verdict: 'VERIFIED' },
    // terraform-docs publishes a .sha256sum and no signature at all: same legitimate
    // exemption as OPA.
    { file: TD, fn: 'verifyChecksumOrSkip', kind: 'SUMS-ABSENT', verdict: 'EXEMPT-NO-SIGNATURE-TRUST-ROOT' },
    { file: TD, fn: 'verifyChecksumOrSkip', kind: 'VERIFY', verdict: 'DISCARDS-ON-FAILURE' },
    { file: TD, fn: 'downloadTo', kind: 'ACQUIRE', verdict: 'EXEMPT-DELEGATES-TO-CALLER' },
    { file: TD, fn: 'downloadFromMirrorUrl', kind: 'ACQUIRE', verdict: 'EXEMPT-DELEGATES-TO-CALLER' },
    { file: TD, fn: 'writeCacheIntegrityMarker', kind: 'RECORD-WRITE', verdict: 'ATOMIC-WRITE' },
    { file: TD, fn: 'verifyCachedTool', kind: 'RECORD-READ', verdict: 'VALIDATES-RECORD' },
];

// --- Table B: the cache-integrity marker's edge states ----------------------

type MarkerRow = {
    what: string;
    /** Marker content; undefined = no marker file. 'MATCH' = the executable's real digest. */
    marker?: string;
    /** verifyCachedTool outcome: false = unverifiable (escalate), true = verified, 'throws' = real mismatch. */
    expect: true | false | 'throws';
};

/**
 * Rows expecting `false` go RED if CACHE_INTEGRITY_MARKER_PATTERN validation is
 * removed or inverted — they then throw a tampering-shaped CachedToolVerificationFailed,
 * which is exactly the brick #198 describes. The `'throws'` row goes RED if the
 * validation is widened so far that a genuine mismatch stops failing.
 */
const MARKER_ROWS: MarkerRow[] = [
    { what: 'no marker at all (legacy cache entry)', marker: undefined, expect: false },
    { what: 'a zero-length marker (interrupted write)', marker: '', expect: false },
    { what: 'a whitespace-only marker', marker: '   \n', expect: false },
    { what: 'a truncated marker (12 of 64 hex characters)', marker: 'aabbccddeeff', expect: false },
    { what: 'an over-long marker (65 hex characters)', marker: 'a'.repeat(65), expect: false },
    { what: 'a 64-character marker that is not hex', marker: 'z'.repeat(64), expect: false },
    { what: 'a marker carrying a filename as well as a digest', marker: `${'a'.repeat(64)}  terraform`, expect: false },
    { what: 'a well-formed marker that matches the cached executable', marker: 'MATCH', expect: true },
    { what: 'a well-formed marker that does NOT match (real tampering)', marker: 'b'.repeat(64), expect: 'throws' },
];

// --- Table C: end-to-end through the task ----------------------------------

type FlowRow = { fixture: string; what: string; outcome: 'success' | 'failure'; forbidText?: string };

const FLOW_ROWS: FlowRow[] = [
    {
        fixture: 'CacheHitVerifyFail',
        what: 'a cache hit whose WELL-FORMED marker does not match the executable (#136)',
        outcome: 'failure',
    },
    {
        fixture: 'CacheHitTruncatedMarkerDegrades',
        what: 'a TRUNCATED marker + an unreachable source degrades instead of bricking the version (#198)',
        outcome: 'success',
        forbidText: 'CachedToolVerificationFailed',
    },
    {
        fixture: 'CacheHitHashUnavailable',
        what: 'a cache hit with no marker and an unreachable source degrades with a warning (#136 must not over-block)',
        outcome: 'success',
    },
    {
        fixture: 'CacheHitReverifyMismatch',
        what: 'a cache hit with no marker whose executable differs from the freshly verified release (#136)',
        outcome: 'failure',
    },
    {
        fixture: 'CacheHitReverifyMirrorWithheld',
        what: 'a reachable MIRROR withholding required material during re-verification — fail closed, not degrade (#136)',
        outcome: 'failure',
    },
    {
        fixture: 'CacheHitReverifyRegistryWithheld',
        what: 'a reachable REGISTRY withholding a required sha256 during re-verification — fail closed (#136)',
        outcome: 'failure',
    },
    {
        fixture: 'CacheHitReverifyGpgFail',
        what: 'a reachable source serving a SHA256SUMS whose signature does not verify during re-verification (#136)',
        outcome: 'failure',
    },
    {
        fixture: 'CacheHitVerifyPass',
        what: 'a cache hit whose marker matches installs offline (#136 must not over-block)',
        outcome: 'success',
    },
];

describe('artifact trust (class test #65/#78/#136/#198/#204)', function () {
    this.timeout(30000);

    describe('A. every enumerated trust site in this repo', () => {
        let stdout: string;
        try {
            stdout = execFileSync(
                process.execPath,
                [path.join(REPO_ROOT, 'scripts/check-artifact-trust.js'), REPO_ROOT, '--json'],
                { encoding: 'utf8' },
            );
        } catch (err) {
            stdout = String((err as { stdout?: string }).stdout ?? '');
            assert.ok(stdout.trim().startsWith('{'), `signature produced no JSON: ${String(err)}`);
        }
        const report = JSON.parse(stdout) as {
            sites: Array<{ rel: string; fn: string; kind: string; verdict: string; why: string; line: number }>;
            failures: number;
        };

        it('leaves no residual instance of the class anywhere in src/', () => {
            assert.strictEqual(
                report.failures, 0,
                `residual artifact-trust sites:\n${JSON.stringify(report.sites, null, 2)}`,
            );
        });

        it('enumerates exactly the sites this table accounts for', () => {
            const key = (s: { rel?: string; file?: string; kind: string; fn: string; verdict: string }) =>
                `${s.rel ?? s.file}:${s.kind}:${s.fn}:${s.verdict}`;
            assert.deepStrictEqual(
                report.sites.map(key).sort(), SITE_ROWS.map(key).sort(),
                'a trust site appeared, vanished, or changed verdict — add it to SITE_ROWS with its verdict',
            );
        });

        for (const row of SITE_ROWS) {
            it(`${row.file.split('/')[1]} ${row.fn}() [${row.kind}] is ${row.verdict}`, () => {
                const site = report.sites.find(s => s.rel === row.file && s.fn === row.fn && s.kind === row.kind && s.verdict === row.verdict);
                assert.ok(site, `site not found with that verdict: ${row.file} ${row.fn} [${row.kind}] ${row.verdict}`);
            });
        }
    });

    describe('B1. a verification failure discards the artifact (#204)', () => {
        // mkdtempSync creates a unique 0700 directory atomically. A Math.random()
        // name in the shared temp dir is guessable and the write is not O_EXCL, so
        // a local user could pre-plant a symlink at that path and redirect it
        // (CWE-377/378) -- the reason src/ uses secure-temp.ts.
        function tempArtifact(content: string): string {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-trust-'));
            const file = path.join(dir, 'artifact.zip');
            fs.writeFileSync(file, content);
            return file;
        }

        it('a checksum MISMATCH deletes the downloaded artifact', async () => {
            const artifact = tempArtifact('tampered-zip-bytes');
            try {
                await assert.rejects(
                    discardArtifactOnFailure(artifact, () => verifySha256(artifact, 'a'.repeat(64))),
                    /SHA256|Sha256/,
                );
                assert.ok(!fs.existsSync(artifact), 'a checksum-mismatched artifact must not be left on disk');
            } finally {
                try { fs.unlinkSync(artifact); } catch { /* already gone, which is the point */ }
            }
        });

        it('a SIGNATURE failure deletes the downloaded artifact', async () => {
            const artifact = tempArtifact('unsigned-zip-bytes');
            try {
                await assert.rejects(
                    discardArtifactOnFailure(artifact, async () => { throw new VerificationFailure('GPG signature verification failed for SHA256SUMS'); }),
                    /GPG signature verification failed/,
                );
                assert.ok(!fs.existsSync(artifact), 'an artifact whose signature failed must not be left on disk');
            } finally {
                try { fs.unlinkSync(artifact); } catch { /* already gone */ }
            }
        });

        it('a PASSING verification keeps the artifact (the guard must not delete good downloads)', async () => {
            const artifact = tempArtifact('good-zip-bytes');
            const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
            try {
                await discardArtifactOnFailure(artifact, () => verifySha256(artifact, digest));
                assert.ok(fs.existsSync(artifact), 'a verified artifact must survive');
            } finally {
                try { fs.unlinkSync(artifact); } catch { /* best effort */ }
            }
        });

        it('an unlink failure does not mask the verification error', async () => {
            const missing = path.join(os.tmpdir(), `artifact-trust-absent-${process.pid}.zip`);
            await assert.rejects(
                discardArtifactOnFailure(missing, async () => { throw new VerificationFailure('checksum mismatch'); }),
                /checksum mismatch/,
            );
        });

        it('the discard is reported to the caller-supplied debug sink, naming the artifact', async () => {
            // The sink is the operator's ONLY signal that a rejected artifact was
            // removed. It is injected because the package does not import the ADO
            // task lib, which makes it a parameter a caller can silently omit —
            // exactly the kind of loss no other assertion here would notice.
            const artifact = tempArtifact('tampered-zip-bytes');
            const logged: string[] = [];
            try {
                await assert.rejects(
                    discardArtifactOnFailure(
                        artifact,
                        () => verifySha256(artifact, 'a'.repeat(64)),
                        { debug: (message: string) => { logged.push(message); } },
                    ),
                    /SHA256|Sha256/,
                );
                assert.ok(
                    logged.some(m => m.includes(artifact) && /discard/i.test(m)),
                    `the discard must be reported to the debug sink and name the artifact. logged: ${JSON.stringify(logged)}`,
                );
            } finally {
                try { fs.unlinkSync(artifact); } catch { /* already discarded, which is the point */ }
            }
        });
    });

    describe('B2. the cache-integrity marker\'s edge states (#198/#136)', () => {
        const MARKER = '.installer-verified.sha256';
        let dir: string;
        let exe: string;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-trust-cache-'));
            exe = path.join(dir, 'terraform');
            fs.writeFileSync(exe, 'cached-terraform-binary');
        });
        afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

        const actualDigest = () => crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');

        for (const row of MARKER_ROWS) {
            it(`${row.expect === 'throws' ? 'fails on' : `reports ${row.expect} for`} ${row.what}`, async () => {
                if (row.marker !== undefined) {
                    fs.writeFileSync(path.join(dir, MARKER), row.marker === 'MATCH' ? actualDigest() : row.marker);
                }
                if (row.expect === 'throws') {
                    await assert.rejects(verifyCachedTool(dir, exe, 'terraform 1.9.8'));
                    return;
                }
                assert.strictEqual(await verifyCachedTool(dir, exe, 'terraform 1.9.8'), row.expect);
            });
        }

        it('writes the marker atomically, leaving no temp file behind', async () => {
            await writeCacheIntegrityMarker(dir, exe);
            assert.strictEqual(fs.readFileSync(path.join(dir, MARKER), 'utf8'), actualDigest());
            assert.deepStrictEqual(
                fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [],
                'an atomic write must not leave a temp file behind',
            );
        });

        it('heals a torn marker: re-writing restores a verifiable entry', async () => {
            fs.writeFileSync(path.join(dir, MARKER), 'aabbccddeeff');
            assert.strictEqual(await verifyCachedTool(dir, exe, 'terraform 1.9.8'), false, 'a torn marker must read as unverifiable');
            await writeCacheIntegrityMarker(dir, exe);
            assert.strictEqual(await verifyCachedTool(dir, exe, 'terraform 1.9.8'), true, 're-writing must restore a verifiable entry');
        });
    });

    describe('C. the same states end-to-end through the task', () => {
        before(() => {
            delete process.env.NODE_OPTIONS;
            (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
                return process.execPath;
            };
        });

        for (const row of FLOW_ROWS) {
            it(`${row.outcome === 'failure' ? 'fails' : 'installs'} when ${row.what}`, async () => {
                const tr = new ttm.MockTestRunner(path.join(__dirname, `${row.fixture}.js`));
                await tr.runAsync();
                const detail = `\nSTDOUT: ${tr.stdout}\nSTDERR: ${tr.stderr}`;
                if (row.outcome === 'failure') {
                    assert.ok(tr.failed, `task should have failed (${row.fixture})${detail}`);
                    assert.ok(tr.errorIssues.length > 0, `should have an error issue (${row.fixture})${detail}`);
                } else {
                    assert.ok(tr.succeeded, `task should have succeeded (${row.fixture})${detail}`);
                    assert.strictEqual(tr.errorIssues.length, 0, `should have no errors (${row.fixture})${detail}`);
                }
                if (row.forbidText) {
                    assert.ok(
                        !tr.stdout.includes(row.forbidText),
                        `"${row.forbidText}" must not appear — an unverifiable marker must not be reported as tampering (${row.fixture})${detail}`,
                    );
                }
            });
        }
    });
});
