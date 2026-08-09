import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CLASS TEST — hardened temp-file writes (#881 / #882 / #887).
 *
 * Defect class: "A file derived from plan/state/output/verification material
 * is written with a bare fs.writeFileSync into a shared, never-purged OS temp
 * directory instead of the repo's hardened secret-file primitive, and/or is
 * never registered for scrub-then-unlink cleanup."
 *
 * This is a hand-maintained, whole-repo site enumeration (SITE_ROWS), mirroring
 * NetworkRetryClassL0.ts's Table B / EgressAuthorizationL0.ts's SITE_ROWS
 * style. There is no matching auto-detection script backing this table (out of
 * scope for this batch) -- the file-existence check in each row is a
 * lightweight guard against a row going stale, not a full re-derivation. The
 * concrete behavioral regression tests for the three fixed sites live next to
 * the code they cover:
 *   - #881: Tests/PlanTests/Azure/AzurePlanSuccessPublishSummaryL0.ts (digest
 *     attachment permission assertion)
 *   - #882: TerraformDriftReportV1/Tests/SecureTempL0.ts (tempDir preference)
 *     and .../Tests/SignalHandlerL0.ts (emergency-cleanup registration)
 *   - #887: TerraformInstallerV1/Tests/CosignVerifierL0.ts ("verification-input
 *     temp files" describe block)
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('hardened temp-file writes coverage (class test #881/#882/#887)', function () {
  type Verdict = 'HARDENED' | 'FIXED' | 'EXEMPT';
  type SiteRow = { file: string; fn: string; sink: string; verdict: Verdict; why: string };

  const SITE_ROWS: SiteRow[] = [
    // --- fixed this batch ---
    {
      file: 'Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts',
      fn: 'writeAndAttachDigest',
      sink: 'fs.writeFileSync -> writeSecretFile',
      verdict: 'FIXED',
      why: '#881: the plan/state/apply digest attachment now goes through the same 0600/O_EXCL primitive as the sibling raw-plan attachment (plan()) written moments earlier in the same class.',
    },
    {
      file: 'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/sarif.ts',
      fn: 'writeSarif',
      sink: 'os.tmpdir() default path + no emergency-cleanup registration',
      verdict: 'FIXED',
      why: '#882: the auto-generated path now prefers the caller\'s Agent.TempDirectory (matching index.ts\'s own summaryFile), and the resulting path is registered with index.ts\'s existing SIGTERM/SIGINT/uncaughtException/unhandledRejection emergencyCleanup(), same as summaryFile. The write itself already went through replaceSecretFile -- only location + cleanup registration were the gap.',
    },
    {
      file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/cosign-verifier.ts',
      fn: 'verifyCosignSignature',
      sink: 'fs.writeFileSync(sha256sums/.sig/.pem) into bare os.tmpdir()',
      verdict: 'FIXED',
      why: '#887: now prefers Agent.TempDirectory (matching terraform-installer.ts\'s own tasks.getVariable convention in this same task) and writes the three inputs inside a per-invocation mkdtempSync directory (0700, atomically created), so a pre-planted path cannot be followed at all (CWE-59/377). No writeSecretFile-family primitive was added to this task -- see the batch report\'s notes for the deliberate narrower-hardening justification (public verification material, no credential trust model in this task).',
    },

    // --- already hardened, unchanged ---
    {
      file: 'Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts',
      fn: 'plan (raw terraform-plan-results attachment)',
      sink: 'writeSecretFile',
      verdict: 'HARDENED',
      why: 'Already written via writeSecretFile (0600/O_EXCL); the sibling writeAndAttachDigest gap fixed above was the only bare fs.writeFileSync left in this file.',
    },
    {
      file: 'Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts',
      fn: 'writeCommandOutputFile (show/output/custom command output files)',
      sink: 'replaceSecretFile',
      verdict: 'HARDENED',
      why: 'A user-named, predictable path (a re-run legitimately overwrites it), so it correctly uses replaceSecretFile (refuses a pre-planted symlink, exclusively re-creates) rather than writeSecretFile.',
    },
    {
      file: 'Tasks/TerraformTask/TerraformTaskV5/src/aws-terraform-command-handler.ts',
      fn: 'applyWifEnvironment (OIDC token file)',
      sink: 'writeSecretFile',
      verdict: 'HARDENED',
      why: 'Credential file, already written via the hardened primitive and tracked in tempFiles.',
    },
    {
      file: 'Tasks/TerraformTask/TerraformTaskV5/src/gcp-terraform-command-handler.ts',
      fn: 'getJsonKeyFilePath / writeBackendWifCredentials / handleProviderWIF',
      sink: 'writeSecretFile',
      verdict: 'HARDENED',
      why: 'Service-account JSON key + WIF token/credentials files, all already written via the hardened primitive and tracked in tempFiles.',
    },
    {
      file: 'Tasks/TerraformTask/TerraformTaskV5/src/oci-terraform-command-handler.ts',
      fn: 'getPrivateKeyFilePath / setupBackend (PAR config) / handleProviderWIF',
      sink: 'writeSecretFile',
      verdict: 'HARDENED',
      why: 'API-key private key, PAR backend config, and ephemeral WIF private key/UPST/config -- all already written via the hardened primitive and tracked in tempFiles (the working-directory PAR config case is additionally covered by registerOciBackendCacheForCleanup).',
    },
    {
      file: 'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/index.ts',
      fn: 'run (drift-summary file)',
      sink: 'writeSecretFile',
      verdict: 'HARDENED',
      why: 'Already written via writeSecretFile under Agent.TempDirectory, and already registered with emergencyCleanup() -- the reference implementation the sibling writeSarif fix (above) was missing.',
    },
    {
      file: 'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/results.ts',
      fn: 'writeResultsFile / writeJUnit / writeSarif',
      sink: 'writeSecretFile / replaceSecretFile, under a tempDir() helper that prefers Agent.TempDirectory',
      verdict: 'HARDENED',
      why: 'Already correct on both location and permissions. Deliberately NOT actively cleanup-tracked in index.ts\'s tempDirs/cleanup() -- confirmed by direct read, matching this file\'s own documented design: later pipeline steps consume these via output variables, so the job-end Agent.TempDirectory purge is the accepted cleanup mechanism (the same accepted pattern TerraformDriftReport\'s sarif.ts now also gets, plus the extra defense-in-depth signal-handler tier TerraformDriftReport happens to already have built for its summary file).',
    },
    {
      file: 'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/sentinel-engine.ts',
      fn: 'generateConfig (sentinel.hcl)',
      sink: 'fs.writeFileSync, under a fresh Agent.TempDirectory-preferring uuid directory',
      verdict: 'HARDENED',
      why: 'Content is policy names/paths, not plan attribute VALUES. The containing directory is freshly created (mkdirSync) immediately before the write, so a pre-planted symlink at this exact path is not feasible, and the directory is pushed onto tempDirs -- confirmed by direct read that index.ts\'s cleanup()/emergencyCleanup path recursively removes it (which also removes sentinel.hcl inside it) on both normal completion and SIGTERM/SIGINT/uncaughtException/unhandledRejection.',
    },
    {
      file: 'Tasks/TerraformProviderMirror/TerraformProviderMirrorV1/src/index.ts',
      fn: 'run (.terraformrc)',
      sink: 'replaceSecretFile',
      verdict: 'HARDENED',
      why: 'Credential-bearing (mirrorUrl may embed basic-auth userinfo), already hardened. Deliberately NOT cleanup-tracked BY DESIGN, documented in-line: terraform needs TF_CLI_CONFIG_FILE to point at this file for the rest of the job.',
    },

    // --- exempt, with reasons ---
    {
      file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/http-client.ts',
      fn: 'attemptDownloadToFile',
      sink: 'fs.createWriteStream',
      verdict: 'EXEMPT',
      why: 'Downloads the terraform/tofu TOOL BINARY itself -- the artifact being verified, not plan/state/output/verification-derived content. Already prefers Agent.TempDirectory at every call site (terraform-installer.ts); byte-identical across the 3 installer tasks.',
    },
    {
      file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/http-client.ts',
      fn: 'attemptDownloadToFile',
      sink: 'fs.createWriteStream',
      verdict: 'EXEMPT',
      why: 'Same reasoning as the TerraformInstaller copy; byte-identical.',
    },
    {
      file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/http-client.ts',
      fn: 'attemptDownloadToFile',
      sink: 'fs.createWriteStream',
      verdict: 'EXEMPT',
      why: 'Same reasoning as the TerraformInstaller copy; byte-identical.',
    },
    {
      file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts',
      fn: 'writeCacheIntegrityMarker',
      sink: 'fs.writeFileSync (temp-name-then-rename)',
      verdict: 'EXEMPT',
      why: 'A persistent TOOL-CACHE integrity marker that must survive across jobs by design (enables cache-hit re-verification) -- not an ephemeral per-run temp file. Already atomic (temp name + rename) with cleanup-on-failure.',
    },
    {
      file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts',
      fn: 'writeCacheIntegrityMarker',
      sink: 'fs.writeFileSync (temp-name-then-rename)',
      verdict: 'EXEMPT',
      why: 'Same reasoning as the TerraformInstaller copy.',
    },
    {
      file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts',
      fn: 'writeCacheIntegrityMarker',
      sink: 'fs.writeFileSync (temp-name-then-rename)',
      verdict: 'EXEMPT',
      why: 'Same reasoning as the TerraformInstaller copy.',
    },
    {
      file: 'Tasks/Markdown2Html/Markdown2HtmlV1/src/converter.ts',
      fn: 'processIncludesFile / processFileList',
      sink: 'fs.writeFileSync(outputPath)',
      verdict: 'EXEMPT',
      why: 'Not Terraform plan/state/verification-derived content at all (markdown-to-HTML doc conversion). outputPath is an operator-specified path that must persist as a build artifact by design.',
    },
    {
      file: 'Tasks/PublishKbArticle/PublishKbArticleV1/src/manifest.ts',
      fn: 'appendToManifest / outputArticleInfoToJson',
      sink: 'fs.writeFileSync',
      verdict: 'EXEMPT',
      why: 'ServiceNow KB-article manifest/handoff metadata, not Terraform plan/state/output/verification-derived content.',
    },
  ];

  for (const row of SITE_ROWS) {
    it(`${row.file}: ${row.fn}() -> ${row.sink} is ${row.verdict}`, () => {
      const fullPath = path.join(REPO_ROOT, row.file);
      assert.ok(fs.existsSync(fullPath), `file no longer exists at the recorded path: ${row.file}`);
      assert.ok(row.why.length > 0, 'every row must carry a reason');
    });
  }

  it('every verdict is one of the three recognized values', () => {
    for (const row of SITE_ROWS) {
      assert.ok(['HARDENED', 'FIXED', 'EXEMPT'].includes(row.verdict), `unrecognized verdict on ${row.file}:${row.fn}`);
    }
  });

  describe('regression guards for the three FIXED sites (source-level, in addition to the behavioral tests listed above)', () => {
    it('#881: writeAndAttachDigest calls writeSecretFile, not a bare fs.writeFileSync', () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts'), 'utf8');
      const start = src.indexOf('private writeAndAttachDigest(');
      assert.ok(start >= 0, 'writeAndAttachDigest not found');
      const body = src.slice(start, src.indexOf('\n    }', start));
      assert.ok(/\bwriteSecretFile\(digestPath/.test(body), 'writeAndAttachDigest must write digestPath via writeSecretFile');
      assert.ok(!/\bfs\.writeFileSync\(/.test(body), 'writeAndAttachDigest must not use a bare fs.writeFileSync');
    });

    it('#882: writeSarif accepts a tempDir parameter and the auto-generated path is built from it, not a bare os.tmpdir()', () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/sarif.ts'), 'utf8');
      const sigStart = src.indexOf('export function writeSarif(');
      assert.ok(sigStart >= 0, 'writeSarif export not found');
      const sigEnd = src.indexOf('{', sigStart);
      const signature = src.slice(sigStart, sigEnd);
      assert.ok(/tempDir\s*:\s*string/.test(signature), `writeSarif must accept a tempDir parameter; got signature: ${signature}`);
      const body = src.slice(sigEnd);
      assert.ok(/path\.join\(tempDir,/.test(body), 'the auto-generated SARIF path must be built from tempDir');
    });

    it('#887: verifyCosignSignature writes the verification-input files inside a per-invocation mkdtemp directory under Agent.TempDirectory', () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'Tasks/TerraformInstaller/TerraformInstallerV1/src/cosign-verifier.ts'), 'utf8');
      assert.ok(
        /fs\.mkdtempSync\(path\.join\(tasks\.getVariable\(["']Agent\.TempDirectory["']\)\s*\|\|\s*os\.tmpdir\(\),/.test(src),
        'expected the scratch directory to be created via mkdtempSync under Agent.TempDirectory, falling back to os.tmpdir()',
      );
      const writeCalls = src.match(/fs\.writeFileSync\([^;]*\);/g) ?? [];
      const sha256Writes = writeCalls.filter((c) => /sha256SumsPath|signaturePath|certificatePath/.test(c));
      assert.strictEqual(sha256Writes.length, 3, `expected exactly 3 writes of the verification-input files; found: ${sha256Writes.length}`);
      for (const p of ['sha256SumsPath', 'signaturePath', 'certificatePath']) {
        assert.ok(
          new RegExp(`const ${p} = path\\.join\\(scratchDir,`).test(src),
          `${p} must be built from the mkdtemp scratch directory, not the shared temp root`,
        );
      }
      assert.ok(/fs\.rmSync\(scratchDir,\s*\{\s*recursive:\s*true/.test(src), 'the scratch directory must be removed recursively on the way out');
    });
  });
});
