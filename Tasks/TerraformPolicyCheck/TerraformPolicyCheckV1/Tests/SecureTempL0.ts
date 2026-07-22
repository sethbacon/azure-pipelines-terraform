import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import cp = require('child_process');
import { writeSecretFile, replaceSecretFile, scrubFile } from '../src/secure-temp';

/**
 * Direct unit tests for this task's copy of writeSecretFile/replaceSecretFile
 * (#607). The module is a byte-identical copy of TerraformTaskV5's
 * secure-temp.ts (gated by scripts/check-shared-modules.js); these tests
 * exercise it from TerraformPolicyCheck's own compiled output, in this task's
 * own package context, since results.ts (raw engine output, JUnit XML, and
 * SARIF report writes) now depends on it for the same Windows-DACL guarantee
 * TerraformTaskV5 and TerraformDriftReport already have.
 */
describe('secure-temp (TerraformPolicyCheck copy) — exclusive create + cross-platform permission hardening', function () {
    // monkeypatch the shared child_process module
    const c = cp as any;
    const origExecFileSync = c.execFileSync;
    const origPlatform = process.platform;
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-secure-temp-test-'));
    });

    afterEach(() => {
        c.execFileSync = origExecFileSync;
        Object.defineProperty(process, 'platform', { value: origPlatform });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('writeSecretFile writes the file with the expected content (mode 0600 on Unix)', () => {
        const target = path.join(scratchDir, 'policy-results.txt');
        writeSecretFile(target, 'raw engine output');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'raw engine output');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('writeSecretFile refuses to overwrite an existing file at the target path (O_EXCL)', () => {
        const target = path.join(scratchDir, 'existing.txt');
        fs.writeFileSync(target, 'pre-existing');
        assert.throws(() => writeSecretFile(target, 'new-secret'), /EEXIST/);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'pre-existing', 'the pre-existing file must be untouched');
    });

    it('writeSecretFile requests an exclusive create (flag "wx") so a pre-planted symlink cannot be followed (#757)', () => {
        // A real pre-planted symlink cannot be created deterministically in
        // every CI environment (Windows requires SeCreateSymbolicLinkPrivilege/
        // Developer Mode; this test previously used this.skip() when that
        // privilege was unavailable, which --forbid-pending now treats as a
        // hard failure). writeSecretFile has no application-level symlink
        // check of its own -- it relies entirely on the OS/runtime honoring
        // O_EXCL (Node's flag: 'wx'), which POSIX guarantees refuses ANY
        // pre-existing path node, symlink or not. Asserting the flag is
        // requested is therefore a deterministic, causal proof of the same
        // security property, on every platform, with no privilege dependency.
        const f = fs as unknown as { writeFileSync: typeof fs.writeFileSync };
        const origWriteFileSync = f.writeFileSync;
        let seenOptions: unknown;
        f.writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
            seenOptions = args[2];
            return origWriteFileSync(...args);
        };
        const target = path.join(scratchDir, 'flag-check.txt');
        try {
            writeSecretFile(target, 'secret');
        } finally {
            f.writeFileSync = origWriteFileSync;
        }
        assert.deepStrictEqual(seenOptions, { mode: 0o600, flag: 'wx' });
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'secret');
    });

    it('writeSecretFile restricts the DACL via icacls on win32 (inheritance stripped, only the current user granted)', () => {
        let seen: { file: string, args: string[] } | undefined;
        c.execFileSync = (file: string, args: string[]) => { seen = { file, args }; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'win32' });

        const target = path.join(scratchDir, 'win-results.txt');
        writeSecretFile(target, 'win-secret');

        assert.ok(seen, 'icacls must be invoked on win32');
        assert.strictEqual(seen!.file, 'icacls');
        assert.strictEqual(seen!.args[0], target);
        assert.ok(seen!.args.includes('/inheritance:r'), 'inherited ACEs must be stripped');
        for (const sid of ['*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11', '*S-1-5-32-546']) {
            assert.ok(seen!.args.includes(sid), `well-known broad principal ${sid} must be removed`);
        }
    });

    it('writeSecretFile fails closed when the icacls restriction cannot be applied on win32', () => {
        c.execFileSync = () => { throw new Error('icacls exploded'); };
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const target = path.join(scratchDir, 'win-fail.txt');
        assert.throws(() => writeSecretFile(target, 'win-secret'), /Failed to set restrictive ACL/);
    });

    it('writeSecretFile does not invoke icacls on non-Windows platforms', () => {
        let called = false;
        c.execFileSync = () => { called = true; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const target = path.join(scratchDir, 'unix-results.txt');
        writeSecretFile(target, 'unix-secret');
        assert.strictEqual(called, false, 'icacls must not run on Unix -- chmod 0600 already applied');
    });

    // #634: if the post-write permission-hardening throws, writeSecretFile must
    // scrub+remove the already-written credential file before re-throwing rather
    // than leaving it orphaned and untracked (call sites register the path only
    // on the next line), while still failing closed.
    it('on Unix, removes the orphaned file when chmod fails and still fails closed (#634)', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const f = fs as unknown as { chmodSync: typeof fs.chmodSync };
        const origChmodSync = f.chmodSync;
        f.chmodSync = () => { throw new Error('EPERM'); };
        const target = path.join(scratchDir, 'unix-orphan.txt');
        try {
            assert.throws(() => writeSecretFile(target, 'unix-secret'), /Failed to set restrictive permissions/);
        } finally {
            f.chmodSync = origChmodSync;
        }
        assert.strictEqual(fs.existsSync(target), false, 'the orphaned credential file must be removed, not left on disk');
    });

    it('on win32, removes the orphaned file when the DACL cannot be applied and still fails closed (#634)', () => {
        c.execFileSync = () => { throw new Error('icacls exploded'); };
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const target = path.join(scratchDir, 'win-orphan.txt');
        assert.throws(() => writeSecretFile(target, 'win-secret'), /Failed to set restrictive ACL/);
        assert.strictEqual(fs.existsSync(target), false, 'the orphaned credential file must be removed, not left on disk');
    });

    // Real-ACL integration check: only meaningful (and only runs) on Windows
    // agents, mirroring TerraformTaskV5's own win32 integration test for #495.
    it('win32 integration: no broad principal retains access; the current user keeps full control', () => {
        if (origPlatform !== 'win32') return; // guard clause, not it.skip (#757): keeps this test out of --forbid-pending's reach on non-Windows CI legs.
        const target = path.join(scratchDir, 'real-acl.txt');
        writeSecretFile(target, 'real-secret');
        const aclOutput = cp.execFileSync('icacls', [target], { encoding: 'utf8' });
        const aceLines = aclOutput.split(/\r?\n/).filter((line: string) => line.includes(':('));
        assert.ok(aceLines.length >= 1, `expected at least the current-user ACE, got: ${aclOutput}`);
        for (const broad of ['Everyone', 'BUILTIN\\Users', 'Authenticated Users', 'Guests']) {
            assert.ok(!aclOutput.includes(broad), `broad principal '${broad}' must not retain access: ${aclOutput}`);
        }
        const userName = process.env['USERNAME'] as string;
        const userAce = aceLines.find((line: string) => line.toLowerCase().includes(userName.toLowerCase()));
        assert.ok(userAce && userAce.includes('(F)'), `the current user must hold a full-control ACE: ${aclOutput}`);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'real-secret', 'the current user must still be able to read the file');
    });
});

/**
 * Direct unit tests for replaceSecretFile, used by results.ts's writeSarif for
 * the user-named, predictable sarifPath output: a re-run legitimately
 * overwrites a previous run's SARIF file, but a pre-planted symlink is
 * refused outright.
 */
describe('replaceSecretFile (TerraformPolicyCheck copy) — user-named SARIF output path', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-replace-secret-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('creates the file when nothing exists at the target', () => {
        const target = path.join(scratchDir, 'policy.sarif');
        replaceSecretFile(target, '{"version":"2.1.0"}');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"version":"2.1.0"}');
    });

    it('overwrites a pre-existing regular file (re-run semantics)', () => {
        const target = path.join(scratchDir, 'policy.sarif');
        fs.writeFileSync(target, 'old-run');
        replaceSecretFile(target, 'new-run');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new-run');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('refuses to write through a path reported as a symlink (#757)', () => {
        // A pre-existing regular file stands in for a pre-planted symlink so
        // the assertion is deterministic on every platform/CI environment
        // (this test previously used this.skip() when the environment could
        // not create a real symlink, which --forbid-pending now treats as a
        // hard failure): replaceSecretFile's refusal is driven entirely by
        // fs.lstatSync(...).isSymbolicLink(), so mocking that call to report
        // "yes, a symlink" exercises the exact same guarded branch a real
        // symlink would.
        const link = path.join(scratchDir, 'policy.sarif');
        fs.writeFileSync(link, 'placeholder-content');
        const f = fs as unknown as { lstatSync: (p: fs.PathLike) => fs.Stats };
        const origLstatSync = f.lstatSync;
        f.lstatSync = () => ({ isSymbolicLink: () => true }) as fs.Stats;
        try {
            assert.throws(() => replaceSecretFile(link, 'captured'), /symbolic link/);
        } finally {
            f.lstatSync = origLstatSync;
        }
        assert.strictEqual(fs.readFileSync(link, 'utf8'), 'placeholder-content', 'a path reported as a symlink must not be overwritten');
    });
});

/**
 * Direct unit tests for this task's copy of scrubFile (#595): overwrites a
 * secret temp file's content with zeros before cleanupTempFiles() unlinks it.
 * PolicyCheck's own runtime never calls scrubFile today, but the module is a
 * byte-identical copy of TerraformTaskV5's secure-temp.ts (gated by
 * scripts/check-shared-modules.js), so it is exercised here from this task's
 * own compiled output to give the parity copy real coverage.
 */
describe('scrubFile (TerraformPolicyCheck copy) — overwrite-before-unlink content scrub (#595)', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-scrub-file-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('overwrites the file content with zeros of the same length, preserving the file', () => {
        const target = path.join(scratchDir, 'secret.txt');
        const original = 'top-secret-bearer-token-value';
        fs.writeFileSync(target, original);
        scrubFile(target);
        const scrubbed = fs.readFileSync(target);
        assert.strictEqual(scrubbed.length, Buffer.byteLength(original), 'scrub must not change the file length');
        assert.ok(scrubbed.every((b) => b === 0), 'every byte must be overwritten with zero');
    });

    it('is a no-op for a file that no longer exists', () => {
        const missing = path.join(scratchDir, 'does-not-exist.txt');
        assert.doesNotThrow(() => scrubFile(missing));
    });

    it('is a no-op for an already-empty file', () => {
        const target = path.join(scratchDir, 'empty.txt');
        fs.writeFileSync(target, '');
        assert.doesNotThrow(() => scrubFile(target));
        assert.strictEqual(fs.readFileSync(target, 'utf8'), '');
    });

    it('does not follow a path reported as a symlink onto a victim file (CWE-59) (#757)', () => {
        // Same deterministic-mock rationale as replaceSecretFile's symlink
        // test above (#757): scrubFile's refusal to write through a symlink
        // is driven entirely by fs.lstatSync(...).isSymbolicLink(), so
        // mocking it is a faithful, privilege-independent substitute for a
        // real pre-planted symlink.
        const target = path.join(scratchDir, 'tracked-temp-file.tf');
        const original = 'victim-secret-content';
        fs.writeFileSync(target, original);
        const f = fs as unknown as { lstatSync: (p: fs.PathLike) => fs.Stats };
        const origLstatSync = f.lstatSync;
        f.lstatSync = () => ({ isSymbolicLink: () => true }) as fs.Stats;
        try {
            assert.doesNotThrow(() => scrubFile(target));
        } finally {
            f.lstatSync = origLstatSync;
        }
        assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'a path reported as a symlink must not be zeroed');
    });
});
