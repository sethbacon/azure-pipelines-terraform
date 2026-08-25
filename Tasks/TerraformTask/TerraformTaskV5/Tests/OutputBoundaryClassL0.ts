import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import { replaceSecretFile, writeSecretFile } from '../src/secure-temp';

/**
 * CLASS TEST — "a value that originates in template-, tool- or remote-service-
 * controlled output crosses a trust boundary (a pipeline output variable, a file
 * path, a parsed file) without content validation or containment, or is DROPPED
 * before it can cross because the producing exec rejected."
 *
 * Cross-repo counterpart of azure-pipelines-packer's
 * Tests/OutputBoundaryClassL0.ts (issues #101/#202/#203/#110 were filed there;
 * the same idioms are copied between the two extensions, so the class is
 * enumerated and fixed in both).
 *
 * The rows are the ENUMERATED SINKS produced by the re-runnable signature
 * `signatures/batch-E-output-boundary-signature.cjs` (S1 output variables, S2
 * path writes, S3 exec-dropped crossings, S4 unbounded parses) -- not one test
 * per reported call site.
 *
 * Every behavioural row is mutation-provable: inverting that row's own guard
 * predicate turns that row RED and leaves the others green. EXEMPT rows assert
 * the structural property the exemption rests on.
 *
 * Rows whose sink lives in a SIBLING task package are asserted structurally
 * here and behaviourally there. Each task directory is an independent npm
 * package with its own node_modules, so a sibling's module cannot be imported
 * from this package (PublishKbArticleV1/src/manifest.ts imports
 * `azure-pipelines-task-lib/task`, which does not resolve here) -- reading that
 * package's source as TEXT needs no import and always resolves. The executable
 * counterparts of the three PublishKbArticleV1 rows below live in
 * Tasks/PublishKbArticle/PublishKbArticleV1/Tests/OutputBoundaryClassL0.ts.
 */

const SRC = path.resolve(__dirname, '..', 'src');
const TASKS_ROOT = path.resolve(__dirname, '..', '..', '..');
const KB_SRC = path.join(TASKS_ROOT, 'PublishKbArticle', 'PublishKbArticleV1', 'src');

async function runScenario(relative: string): Promise<ttm.MockTestRunner> {
    const tr = new ttm.MockTestRunner(path.join(__dirname, relative));
    await tr.runAsync();
    return tr;
}

function report(tr: ttm.MockTestRunner, message: string): string {
    return `${message}\n--- STDOUT ---\n${tr.stdout}\n--- STDERR ---\n${tr.stderr}`;
}

describe('Output-boundary defect class (S1 output variables / S2 path writes / S3 dropped crossings / S4 unbounded parse)', function () {
    // Every behavioural row spawns a MockTestRunner child; the first one on a cold
    // Windows agent pays the ts-node compile too and has twice overrun the 10s
    // default (#923). Matches the other MockTestRunner suites, which all raise it.
    this.timeout(20000);

    // --- S1: pipeline output variables ------------------------------------

    it('S1 setVariable(TF_OUT_*) — a provider/module-controlled output value carrying CR/LF never reaches the variable', async () => {
        const tr = await runScenario('./OutputTests/AWSOutputControlCharsRejected.js');
        assert.ok(tr.succeeded, report(tr, 'the output command itself should still succeed'));
        assert.ok(tr.stdout.includes('TF_OUT_safe_output'), report(tr, 'the clean output must still be exported'));
        assert.ok(!tr.stdout.includes('variable=TF_OUT_malicious_output'), report(tr, 'a control-char-bearing output must be skipped'));
        assert.ok(
            tr.warningIssues.some((w) => w.includes('failed output-variable validation')),
            report(tr, 'the rejection must be visible as a warning')
        );
    });

    it('S1 setVariable(showFilePath) — a control-char-bearing resolved path is rejected, not exported', async function () {
        if (process.platform === 'win32') {
            // NTFS cannot hold '\n' in a directory name, so the behavioural form of
            // this row is POSIX-only. Assert the wiring structurally instead of
            // pending the row (the suite runs with --forbid-pending).
            const base = fs.readFileSync(path.join(SRC, 'base-terraform-command-handler.ts'), 'utf8');
            assert.ok(
                /const safeShowFilePath = this\.resultsPublisher\.sanitizeOutputVariableValue\(showFilePath\);[\s\S]{0,200}?tasks\.setVariable\('showFilePath', safeShowFilePath/.test(base),
                'showFilePath must be exported only through the output-variable guard'
            );
            return;
        }
        const tr = await runScenario('./OutputBoundaryTests/ShowFilePathControlCharsRejected.js');
        assert.ok(!tr.stdout.includes('variable=showFilePath'), report(tr, 'showFilePath must be skipped when the resolved path is not printable-ASCII'));
        assert.ok(
            tr.warningIssues.some((w) => w.includes('failed output-variable validation')),
            report(tr, 'the rejection must be visible as a warning')
        );
    });

    it('S1 setVariable(kbArticleId/kbArticleNumber/kbWorkflowState) — SIBLING PACKAGE: every PublishKbArticleV1 output variable is emitted only as the output-variable guard\'s return value', () => {
        // The console echoes of these same three fields were newline-neutralized
        // (#693) while the sibling setVariable calls had no validation at all --
        // "the guard exists and one sink is missing from it".
        const index = fs.readFileSync(path.join(KB_SRC, 'index.ts'), 'utf8');
        for (const variableName of ['kbArticleId', 'kbArticleNumber', 'kbWorkflowState']) {
            assert.ok(
                new RegExp(`\\['${variableName}', '\\w+'\\]`).test(index),
                `${variableName} must be declared in the guarded output-variable table`
            );
        }
        assert.ok(
            /const safeValue = sanitizeOutputVariableValue\(article\[field\]\);[\s\S]{0,400}?tasks\.setVariable\(variableName, safeValue,/.test(index),
            'the three ServiceNow-response fields must reach setVariable only as the guard\'s return value'
        );
        // ...and there is no OTHER setVariable call in the task that bypasses it.
        const setVariableCalls = index.match(/tasks\.setVariable\(/g) || [];
        assert.strictEqual(setVariableCalls.length, 1, 'every PublishKbArticleV1 output variable must go through the single guarded table');
        // The guard itself: unknown-typed (an `as string` cast is erased at
        // runtime, so a JSON object in that field used to reach setVariable),
        // length-capped, printable-ASCII-only.
        const manifestSrc = fs.readFileSync(path.join(KB_SRC, 'manifest.ts'), 'utf8');
        assert.ok(/export function sanitizeOutputVariableValue\(value: unknown\)/.test(manifestSrc), 'the guard must accept unknown, not a cast-erased string');
        assert.ok(/text\.length > OUTPUT_VAR_MAX_LENGTH/.test(manifestSrc), 'the guard must cap the value length');
        assert.ok(/return \/\^\[\\x20-\\x7E\]\+\$\/\.test\(text\) \? text : null;/.test(manifestSrc), 'the guard must require printable ASCII and return null otherwise');
    });

    it('S1 setVariable(*Location) — EXEMPT: the exported path is <tools dir>/<literal tool>/<cleanVersion-validated semver>', () => {
        for (const relative of [
            'TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts',
            'TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts',
            'PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts',
        ]) {
            const src = fs.readFileSync(path.join(TASKS_ROOT, relative), 'utf8');
            assert.ok(/tools\.cleanVersion\(resolvedVersion\)/.test(src), `${relative}: the remote-resolved version must pass through tools.cleanVersion()`);
            assert.ok(/if \(!version\) \{[\s\S]{0,240}?throw new Error/.test(src), `${relative}: an unparseable version must fail closed`);
            // The executable basename is `<literal tool name> + <platform extension>`,
            // matched by tasks.match against the extracted tree -- never a name read
            // out of the downloaded archive.
            assert.ok(
                /path\.join\(rootFolder, (toolName|exeName) \+ (getExecutableExtension\(\)|\(isWindows \? "\.exe" : ""\))\)/.test(src),
                `${relative}: the executable basename must be a literal, not archive-supplied`
            );
        }
    });

    // --- S3: crossings dropped by a rejecting exec ------------------------

    it('S3 show(outputTo=file) — the output file and showFilePath are published even when terraform show exits non-zero (task still fails)', async () => {
        const tr = await runScenario('./OutputBoundaryTests/ShowFileFailureStillPublishes.js');
        assert.ok(tr.failed, report(tr, 'a non-zero terraform show must still fail the task'));
        assert.ok(tr.stdout.includes('variable=showFilePath'), report(tr, 'showFilePath must still be published from the captured output'));
    });

    it('S3 output() — jsonOutputVariablesPath is published even when terraform output exits non-zero (task still fails)', async () => {
        const tr = await runScenario('./OutputBoundaryTests/OutputFailureStillPublishes.js');
        assert.ok(tr.failed, report(tr, 'a non-zero terraform output must still fail the task'));
        assert.ok(tr.stdout.includes('variable=jsonOutputVariablesPath'), report(tr, 'jsonOutputVariablesPath must still be published'));
    });

    it('S3 custom(outputTo=file) — customFilePath is published even when the custom command exits non-zero (task still fails)', async () => {
        const tr = await runScenario('./OutputBoundaryTests/CustomFileFailureStillPublishes.js');
        assert.ok(tr.failed, report(tr, 'a non-zero custom command must still fail the task'));
        assert.ok(tr.stdout.includes('variable=customFilePath'), report(tr, 'customFilePath must still be published'));
    });

    // --- S2: path write sinks ---------------------------------------------

    it('S2 writeCommandOutputFile — EXEMPT: every command-output write goes through the unlink-then-O_EXCL primitive, so no planted symlink is followed', () => {
        const base = fs.readFileSync(path.join(SRC, 'base-terraform-command-handler.ts'), 'utf8');
        // #878 moved the write sinks to results-publisher.ts. Both files are read
        // here: checking only the handler would let the bare-write count below pass
        // trivially now that it no longer even imports fs.
        const publisher = fs.readFileSync(path.join(SRC, 'results-publisher.ts'), 'utf8');
        assert.ok(
            /writeCommandOutputFile\([\s\S]{0,300}?replaceSecretFile\(filePath, content\);/.test(publisher),
            'writeCommandOutputFile must delegate to replaceSecretFile'
        );
        // The primitive is exercised rather than read: asserting on its source
        // text would stop meaning anything the moment it moves into
        // @4cloudguru/pipeline-task-ado, and would pass for an implementation
        // that merely mentioned the right words.
        const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-temp-boundary-'));
        try {
            // O_EXCL: an entry already at the path must abort the create rather
            // than be written through.
            const occupied = path.join(probe, 'occupied');
            fs.writeFileSync(occupied, 'planted');
            assert.throws(
                () => writeSecretFile(occupied, 'secret'),
                /EEXIST/,
                "writeSecretFile must create with O_EXCL ('wx')"
            );
            assert.strictEqual(fs.readFileSync(occupied, 'utf8'), 'planted',
                'the pre-existing entry must be left untouched');

            // replaceSecretFile must unlink and re-create rather than write
            // through the existing inode. A hard link is the portable witness:
            // it survives the unlink holding the OLD bytes, so if the twin ever
            // shows the new content the write went through the old entry.
            const target = path.join(probe, 'target');
            const twin = path.join(probe, 'twin');
            fs.writeFileSync(target, 'stale');
            fs.linkSync(target, twin);
            replaceSecretFile(target, 'fresh');
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'fresh',
                'replaceSecretFile must leave the new content at the path');
            assert.strictEqual(fs.readFileSync(twin, 'utf8'), 'stale',
                'replaceSecretFile must re-create exclusively rather than write through an existing entry');

            // A planted symlink is refused outright, never followed (CWE-59).
            // Creating one needs privileges Windows agents may not have, so the
            // assertion is scoped rather than skipped -- this suite forbids
            // pending tests.
            if (process.platform !== 'win32') {
                const decoy = path.join(probe, 'decoy');
                const planted = path.join(probe, 'planted-link');
                fs.writeFileSync(decoy, 'victim');
                fs.symlinkSync(decoy, planted);
                assert.throws(
                    () => replaceSecretFile(planted, 'secret'),
                    /symbolic link/,
                    'replaceSecretFile must refuse a pre-existing symlink'
                );
                assert.strictEqual(fs.readFileSync(decoy, 'utf8'), 'victim',
                    'the symlink target must never be written through');
            }
        } finally {
            fs.rmSync(probe, { recursive: true, force: true });
        }
        // Every command-output write in the handler uses that wrapper, never a
        // bare fs.writeFileSync into an operator-supplied path. The digest
        // attachment write (writeAndAttachDigest) was the one grandfathered
        // exception here; #881 closed it (now writeSecretFile too), so this must
        // stay at zero.
        const bareWrites = [
            ...(base.match(/fs\.writeFileSync\(/g) ?? []),
            ...(publisher.match(/fs\.writeFileSync\(/g) ?? []),
        ];
        assert.strictEqual(bareWrites.length, 0, 'no bare fs.writeFileSync may remain in the handler or results publisher (#881: the digest write must also go through writeSecretFile)');
    });

    it('S2 outputArticleInfoToJson — SIBLING PACKAGE: the ServiceNow-supplied article number is constrained to a separator-free basename before it becomes a write path', () => {
        const manifestSrc = fs.readFileSync(path.join(KB_SRC, 'manifest.ts'), 'utf8');
        // `number` comes straight from the ServiceNow response and is used as a
        // FILE PATH relative to the working directory, so it must be pinned to
        // the shape this task's own reader can find again -- anything else falls
        // back to the in-directory default rather than steering the write.
        assert.ok(
            /const number = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$\/\.test\(rawNumber\)\s*\?\s*rawNumber\s*:\s*'article_info';/.test(manifestSrc),
            'a ServiceNow-supplied article number must pass a separator-free basename check or fall back to article_info'
        );
        assert.ok(/const filename = `\$\{number\}\.json`;/.test(manifestSrc), 'the write must use the validated name, never the raw response field');
    });

    // --- S4: unbounded parse of tool-written content ----------------------

    it('S4 kb-manifest read — SIBLING PACKAGE: the byte cap is measured on the already-open descriptor and rejects before the file is buffered and parsed', () => {
        const src = fs.readFileSync(path.join(KB_SRC, 'manifest.ts'), 'utf8');
        assert.ok(/const MANIFEST_MAX_BYTES = 5 \* 1024 \* 1024;/.test(src), 'the manifest read must be bounded by a byte cap');
        // The cap is measured on the SAME descriptor the read uses (no re-open).
        assert.ok(/fs\.fstatSync\(fd\)\.size/.test(src), 'the size must be measured via fstat on the already-open descriptor (no TOCTOU re-open)');
        // ...and it rejects BEFORE the buffer+parse, not after.
        assert.ok(
            /const size = fs\.fstatSync\(fd\)\.size;\s*if \(size > MANIFEST_MAX_BYTES\) \{[\s\S]{0,300}?throw new Error[\s\S]{0,300}?entries = JSON\.parse\(fs\.readFileSync\(fd, 'utf-8'\)\);/.test(src),
            'the cap must reject before the manifest is buffered and parsed'
        );
    });
});
