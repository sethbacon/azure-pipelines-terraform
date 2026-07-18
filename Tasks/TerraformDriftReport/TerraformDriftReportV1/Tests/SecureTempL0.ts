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
 * exercise it from TerraformDriftReport's own compiled output, in this task's
 * own package context, since index.ts (drift-summary write) and sarif.ts
 * (SARIF report write) now both depend on it for the same Windows-DACL
 * guarantee TerraformTaskV5 already has.
 */
describe('secure-temp (TerraformDriftReport copy) — exclusive create + cross-platform permission hardening', function () {
    // monkeypatch the shared child_process module
    const c = cp as any;
    const origExecFileSync = c.execFileSync;
    const origPlatform = process.platform;
    let scratchDir: string;

    function trySymlink(target: string, linkPath: string): boolean {
        try {
            fs.symlinkSync(target, linkPath, 'file');
            return true;
        } catch {
            return false;
        }
    }

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-secure-temp-test-'));
    });

    afterEach(() => {
        c.execFileSync = origExecFileSync;
        Object.defineProperty(process, 'platform', { value: origPlatform });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('writeSecretFile writes the file with the expected content (mode 0600 on Unix)', () => {
        const target = path.join(scratchDir, 'summary.json');
        writeSecretFile(target, '{"drifted":true}');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"drifted":true}');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('writeSecretFile refuses to overwrite an existing file at the target path (O_EXCL)', () => {
        const target = path.join(scratchDir, 'existing.json');
        fs.writeFileSync(target, 'pre-existing');
        assert.throws(() => writeSecretFile(target, 'new-secret'), /EEXIST/);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'pre-existing', 'the pre-existing file must be untouched');
    });

    it('writeSecretFile refuses to write through a pre-planted symlink instead of following it', function () {
        const victim = path.join(scratchDir, 'victim.json');
        fs.writeFileSync(victim, 'victim-content');
        const link = path.join(scratchDir, 'link.json');
        if (!trySymlink(victim, link)) this.skip();
        assert.throws(() => writeSecretFile(link, 'stolen-secret'), /EEXIST/);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'victim-content', 'the symlink target must not receive the secret');
    });

    it('writeSecretFile restricts the DACL via icacls on win32 (inheritance stripped, only the current user granted)', () => {
        let seen: { file: string, args: string[] } | undefined;
        c.execFileSync = (file: string, args: string[]) => { seen = { file, args }; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'win32' });

        const target = path.join(scratchDir, 'win-summary.json');
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
        const target = path.join(scratchDir, 'win-fail.json');
        assert.throws(() => writeSecretFile(target, 'win-secret'), /Failed to set restrictive ACL/);
    });

    it('writeSecretFile does not invoke icacls on non-Windows platforms', () => {
        let called = false;
        c.execFileSync = () => { called = true; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const target = path.join(scratchDir, 'unix-summary.json');
        writeSecretFile(target, 'unix-secret');
        assert.strictEqual(called, false, 'icacls must not run on Unix -- chmod 0600 already applied');
    });

    // Real-ACL integration check: only meaningful (and only runs) on Windows
    // agents, mirroring TerraformTaskV5's own win32 integration test for #495.
    (origPlatform === 'win32' ? it : it.skip)('win32 integration: no broad principal retains access; the current user keeps full control', () => {
        const target = path.join(scratchDir, 'real-acl.json');
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
 * Direct unit tests for replaceSecretFile, used by sarif.ts for the
 * user-named, predictable sarifPath output: a re-run legitimately overwrites
 * a previous run's SARIF file, but a pre-planted symlink is refused outright.
 */
describe('replaceSecretFile (TerraformDriftReport copy) — user-named SARIF output path', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-replace-secret-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('creates the file when nothing exists at the target', () => {
        const target = path.join(scratchDir, 'drift.sarif');
        replaceSecretFile(target, '{"version":"2.1.0"}');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"version":"2.1.0"}');
    });

    it('overwrites a pre-existing regular file (re-run semantics)', () => {
        const target = path.join(scratchDir, 'drift.sarif');
        fs.writeFileSync(target, 'old-run');
        replaceSecretFile(target, 'new-run');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new-run');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('refuses to write through a pre-existing symlink', function () {
        const victim = path.join(scratchDir, 'victim.sarif');
        fs.writeFileSync(victim, 'victim-content');
        const link = path.join(scratchDir, 'drift.sarif');
        try {
            fs.symlinkSync(victim, link, 'file');
        } catch {
            this.skip();
        }
        assert.throws(() => replaceSecretFile(link, 'captured'), /symbolic link/);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'victim-content', 'the symlink target must not receive the output');
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink must be left in place as evidence, not silently deleted');
    });
});

/**
 * Direct unit tests for this task's copy of scrubFile (#595): overwrites a
 * secret temp file's content with zeros before cleanupTempFiles() unlinks it.
 * DriftReport's own runtime never calls scrubFile today, but the module is a
 * byte-identical copy of TerraformTaskV5's secure-temp.ts (gated by
 * scripts/check-shared-modules.js), so it is exercised here from this task's
 * own compiled output to give the parity copy real coverage.
 */
describe('scrubFile (TerraformDriftReport copy) — overwrite-before-unlink content scrub (#595)', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-scrub-file-test-'));
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

    it('does not follow a symlink onto a victim file (CWE-59)', function () {
        const victim = path.join(scratchDir, 'victim.txt');
        const original = 'victim-secret-content';
        fs.writeFileSync(victim, original);
        const link = path.join(scratchDir, 'tracked-temp-file.tf');
        try {
            fs.symlinkSync(victim, link, 'file');
        } catch {
            this.skip();
        }
        assert.doesNotThrow(() => scrubFile(link));
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), original, 'the symlink target must not be zeroed');
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink entry itself is left for cleanupTempFiles() to unlink');
    });
});
