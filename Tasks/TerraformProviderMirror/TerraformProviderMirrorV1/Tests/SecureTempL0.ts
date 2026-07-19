import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import cp = require('child_process');
import { writeSecretFile, replaceSecretFile, scrubFile } from '../src/secure-temp';

/**
 * Direct unit tests for this task's copy of writeSecretFile/replaceSecretFile
 * (#628). The module is a byte-identical copy of TerraformTaskV5's
 * secure-temp.ts (gated by scripts/check-shared-modules.js); these tests
 * exercise it from TerraformProviderMirror's own compiled output, in this
 * task's own package context, since index.ts now writes the credential-bearing
 * .terraformrc via replaceSecretFile for the same Windows-DACL + O_EXCL
 * guarantee TerraformTaskV5 already has (mirrorUrl may embed basic-auth
 * userinfo).
 */
describe('secure-temp (TerraformProviderMirror copy) — exclusive create + cross-platform permission hardening', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared child_process module
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
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-secure-temp-test-'));
    });

    afterEach(() => {
        c.execFileSync = origExecFileSync;
        Object.defineProperty(process, 'platform', { value: origPlatform });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('writeSecretFile writes the file with the expected content (mode 0600 on Unix)', () => {
        const target = path.join(scratchDir, 'config.terraformrc');
        writeSecretFile(target, 'provider_installation {}');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'provider_installation {}');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('writeSecretFile refuses to overwrite an existing file at the target path (O_EXCL)', () => {
        const target = path.join(scratchDir, 'existing.terraformrc');
        fs.writeFileSync(target, 'pre-existing');
        assert.throws(() => writeSecretFile(target, 'new-secret'), /EEXIST/);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'pre-existing', 'the pre-existing file must be untouched');
    });

    it('writeSecretFile refuses to write through a pre-planted symlink instead of following it', function () {
        const victim = path.join(scratchDir, 'victim.txt');
        fs.writeFileSync(victim, 'victim-content');
        const link = path.join(scratchDir, 'link.terraformrc');
        if (!trySymlink(victim, link)) this.skip();
        assert.throws(() => writeSecretFile(link, 'stolen-secret'), /EEXIST/);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'victim-content', 'the symlink target must not receive the secret');
    });

    it('writeSecretFile restricts the DACL via icacls on win32 (inheritance stripped, only the current user granted)', () => {
        let seen: { file: string, args: string[] } | undefined;
        c.execFileSync = (file: string, args: string[]) => { seen = { file, args }; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'win32' });

        const target = path.join(scratchDir, 'win-config.terraformrc');
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
        const target = path.join(scratchDir, 'win-fail.terraformrc');
        assert.throws(() => writeSecretFile(target, 'win-secret'), /Failed to set restrictive ACL/);
    });

    it('writeSecretFile does not invoke icacls on non-Windows platforms', () => {
        let called = false;
        c.execFileSync = () => { called = true; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const target = path.join(scratchDir, 'unix-config.terraformrc');
        writeSecretFile(target, 'unix-secret');
        assert.strictEqual(called, false, 'icacls must not run on Unix -- chmod 0600 already applied');
    });

    // #634: if the post-write permission-hardening throws, writeSecretFile must
    // scrub+remove the already-written credential file before re-throwing rather
    // than leaving it orphaned and untracked, while still failing closed.
    it('on Unix, removes the orphaned file when chmod fails and still fails closed (#634)', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const f = fs as unknown as { chmodSync: typeof fs.chmodSync };
        const origChmodSync = f.chmodSync;
        f.chmodSync = () => { throw new Error('EPERM'); };
        const target = path.join(scratchDir, 'unix-orphan.terraformrc');
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
        const target = path.join(scratchDir, 'win-orphan.terraformrc');
        assert.throws(() => writeSecretFile(target, 'win-secret'), /Failed to set restrictive ACL/);
        assert.strictEqual(fs.existsSync(target), false, 'the orphaned credential file must be removed, not left on disk');
    });

    // Real-ACL integration check: only meaningful (and only runs) on Windows
    // agents, mirroring TerraformTaskV5's own win32 integration test for #495.
    (origPlatform === 'win32' ? it : it.skip)('win32 integration: no broad principal retains access; the current user keeps full control', () => {
        const target = path.join(scratchDir, 'real-acl.terraformrc');
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
 * Direct unit tests for replaceSecretFile — the primitive index.ts uses for the
 * .terraformrc, whose fixed path in Agent.TempDirectory can legitimately
 * pre-exist from a prior run on a reused self-hosted agent: a stale regular
 * file is overwritten, but a pre-planted symlink is refused outright.
 */
describe('replaceSecretFile (TerraformProviderMirror copy) — .terraformrc config path', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-replace-secret-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('creates the file when nothing exists at the target', () => {
        const target = path.join(scratchDir, '.terraformrc');
        replaceSecretFile(target, 'provider_installation {}');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'provider_installation {}');
    });

    it('overwrites a pre-existing regular file (reused-agent re-run semantics)', () => {
        const target = path.join(scratchDir, '.terraformrc');
        fs.writeFileSync(target, 'old-run');
        replaceSecretFile(target, 'new-run');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new-run');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('refuses to write through a pre-existing symlink', function () {
        const victim = path.join(scratchDir, 'victim.txt');
        fs.writeFileSync(victim, 'victim-content');
        const link = path.join(scratchDir, '.terraformrc');
        try {
            fs.symlinkSync(victim, link, 'file');
        } catch {
            this.skip();
        }
        assert.throws(() => replaceSecretFile(link, 'captured'), /symbolic link/);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'victim-content', 'the symlink target must not receive the config');
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink must be left in place as evidence, not silently deleted');
    });
});

/**
 * Direct unit tests for this task's copy of scrubFile (#595): overwrites a
 * secret temp file's content with zeros. ProviderMirror's own runtime reaches
 * scrubFile only through writeSecretFile's #634 hardening-failure cleanup path,
 * but the module is a byte-identical copy of TerraformTaskV5's secure-temp.ts
 * (gated by scripts/check-shared-modules.js), so it is exercised here from this
 * task's own compiled output to give the parity copy real coverage.
 */
describe('scrubFile (TerraformProviderMirror copy) — overwrite-before-unlink content scrub (#595)', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-scrub-file-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('overwrites the file content with zeros of the same length, preserving the file', () => {
        const target = path.join(scratchDir, 'secret.txt');
        const original = 'user:s3cr3t@mirror.example.com';
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
        const link = path.join(scratchDir, 'tracked-temp-file.terraformrc');
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
