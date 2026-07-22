import * as assert from 'assert';
import fs = require('fs');
import os = require('os');
import path = require('path');
import cp = require('child_process');
import { tightenFilePermissions, writeSecretFile, replaceSecretFile, scrubFile } from '../src/secure-temp';

/**
 * Direct unit tests for tightenFilePermissions (#355): chmods a file already
 * on disk (e.g. one downloaded by a third-party library) to 0600, matching
 * writeSecretFile's platform-aware behavior — fail-closed chmod on Unix, an
 * explicit restrictive DACL via icacls on Windows (#495 sibling: mode 0600 is
 * a no-op there, so without the DACL the downloaded -var-file would keep the
 * directory's inherited, possibly broad, ACL).
 */
describe('tightenFilePermissions — post-hoc chmod for third-party downloads', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared fs module
    const f = fs as any;
    // monkeypatch the shared child_process module
    const c = cp as any;
    const origChmodSync = f.chmodSync;
    const origExecFileSync = c.execFileSync;
    const origPlatform = process.platform;

    afterEach(() => {
        f.chmodSync = origChmodSync;
        c.execFileSync = origExecFileSync;
        Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('chmods the file to 0600 when chmod succeeds (no icacls on Unix)', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        let calledWith: unknown[] | undefined;
        let icaclsCalled = false;
        f.chmodSync = (...args: unknown[]) => { calledWith = args; };
        c.execFileSync = () => { icaclsCalled = true; return Buffer.from(''); };
        tightenFilePermissions('/tmp/downloaded-secure-file-does-not-matter.txt');
        assert.deepStrictEqual(calledWith, ['/tmp/downloaded-secure-file-does-not-matter.txt', 0o600]);
        assert.strictEqual(icaclsCalled, false, 'icacls must not run on Unix -- chmod 0600 already applied');
    });

    it('re-throws when chmod fails on a non-Windows platform (fail closed)', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        f.chmodSync = () => { throw new Error('EPERM'); };
        assert.throws(
            () => tightenFilePermissions('/tmp/downloaded-secure-file.txt'),
            /Failed to set restrictive permissions/,
        );
    });

    it('on win32, swallows the chmod failure but still applies the restrictive DACL (#495)', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        f.chmodSync = () => { throw new Error('not supported'); };
        let seen: { file: string, args: string[] } | undefined;
        c.execFileSync = (file: string, args: string[]) => { seen = { file, args }; return Buffer.from(''); };
        assert.doesNotThrow(() => tightenFilePermissions('/tmp/downloaded-secure-file.txt'));
        assert.ok(seen, 'icacls must be invoked on win32');
        assert.strictEqual(seen!.file, 'icacls');
        assert.strictEqual(seen!.args[0], '/tmp/downloaded-secure-file.txt');
        assert.ok(seen!.args.includes('/inheritance:r'), 'inherited ACEs must be stripped');
    });

    it('on win32, applies the restrictive DACL even when chmod itself did not throw (#495)', () => {
        // Windows chmod silently ignores the 0600 mode rather than failing, so
        // the DACL must be applied unconditionally, not only in the catch branch.
        Object.defineProperty(process, 'platform', { value: 'win32' });
        f.chmodSync = () => { /* Windows chmod: succeeds but does nothing */ };
        let icaclsCalled = false;
        c.execFileSync = () => { icaclsCalled = true; return Buffer.from(''); };
        tightenFilePermissions('/tmp/downloaded-secure-file.txt');
        assert.strictEqual(icaclsCalled, true, 'the DACL restriction must not depend on chmod throwing');
    });

    it('on win32, fails closed when the icacls restriction cannot be applied (#495)', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        f.chmodSync = () => { /* no-op */ };
        c.execFileSync = () => { throw new Error('icacls exploded'); };
        assert.throws(
            () => tightenFilePermissions('/tmp/downloaded-secure-file.txt'),
            /Failed to set restrictive ACL/,
        );
    });
});

/**
 * Direct unit tests for writeSecretFile's exclusive-create hardening (#484)
 * and its Windows DACL restriction (#495). The write must use O_EXCL so a
 * pre-existing file or symlink at the target fails the write instead of
 * being followed; on Windows (where mode 0600 is a no-op) an explicit
 * restrictive DACL must be applied via icacls, failing closed like the Unix
 * chmod branch.
 */
describe('writeSecretFile — exclusive create + cross-platform permission hardening', function () {
    // monkeypatch the shared child_process module
    const c = cp as any;
    const origExecFileSync = c.execFileSync;
    const origPlatform = process.platform;
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-temp-test-'));
    });

    afterEach(() => {
        c.execFileSync = origExecFileSync;
        Object.defineProperty(process, 'platform', { value: origPlatform });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('writes the file with the expected content (mode 0600 on Unix)', () => {
        const target = path.join(scratchDir, 'secret.txt');
        writeSecretFile(target, 'top-secret');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'top-secret');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('refuses to overwrite an existing file at the target path (O_EXCL, #484)', () => {
        const target = path.join(scratchDir, 'existing.txt');
        fs.writeFileSync(target, 'pre-existing');
        assert.throws(() => writeSecretFile(target, 'new-secret'), /EEXIST/);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'pre-existing', 'the pre-existing file must be untouched');
    });

    it('requests an exclusive create (flag "wx") so a pre-planted symlink cannot be followed (#484) (#757)', () => {
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

    it('on win32, restricts the DACL via icacls (inheritance stripped, only the current user granted) (#495)', () => {
        let seen: { file: string, args: string[] } | undefined;
        c.execFileSync = (file: string, args: string[]) => { seen = { file, args }; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'win32' });

        const target = path.join(scratchDir, 'win-secret.txt');
        writeSecretFile(target, 'win-secret');

        assert.ok(seen, 'icacls must be invoked on win32');
        assert.strictEqual(seen!.file, 'icacls');
        assert.strictEqual(seen!.args[0], target);
        assert.ok(seen!.args.includes('/inheritance:r'), 'inherited ACEs must be stripped');
        const grantIdx = seen!.args.indexOf('/grant:r');
        assert.ok(grantIdx > 0, 'the grant must replace, not add');
        assert.ok(/^.+:F$/.test(seen!.args[grantIdx + 1]), 'a single full-control grant for the current user is expected');
        // Broad low-privilege principals are removed by well-known SID so the
        // outcome is deterministic even on Windows builds where
        // /inheritance:r converts inherited ACEs to explicit ones.
        for (const sid of ['*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11', '*S-1-5-32-546']) {
            assert.ok(seen!.args.includes(sid), `well-known broad principal ${sid} must be removed`);
        }
    });

    it('on win32, fails closed when the icacls restriction cannot be applied (#495)', () => {
        c.execFileSync = () => { throw new Error('icacls exploded'); };
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const target = path.join(scratchDir, 'win-fail.txt');
        assert.throws(() => writeSecretFile(target, 'win-secret'), /Failed to set restrictive ACL/);
    });

    it('does not invoke icacls on non-Windows platforms (#495)', () => {
        let called = false;
        c.execFileSync = () => { called = true; return Buffer.from(''); };
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const target = path.join(scratchDir, 'unix-secret.txt');
        writeSecretFile(target, 'unix-secret');
        assert.strictEqual(called, false, 'icacls must not run on Unix -- chmod 0600 already applied');
    });

    // #634: the file exists on disk the instant fs.writeFileSync returns, but the
    // permission-hardening runs afterward and every call site tracks the path for
    // cleanup only on the NEXT line. If hardening throws, writeSecretFile must not
    // leave the (already-written, weaker-permissioned) credential orphaned and
    // untracked -- it scrubs+removes it before re-throwing, while still failing
    // closed.
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
    // agents, where CI (windows-2025) exercises the genuine icacls path. The
    // security property asserted is the one #495 is about: no broad
    // low-privilege principal (Everyone, BUILTIN\Users, Authenticated Users,
    // Guests) may retain access, and the current user keeps full control.
    // NT AUTHORITY\SYSTEM / BUILTIN\Administrators may legitimately remain on
    // machines that stamp them explicitly -- they are the Windows equivalent
    // of root, which Unix 0600 does not exclude either.
    it('win32 integration: no broad principal retains access; the current user keeps full control (#495)', () => {
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
 * Direct unit tests for replaceSecretFile (#484): the writer for
 * user-named, predictable output paths (show/output/custom output files).
 * Re-runs legitimately overwrite a previous regular file, but a pre-planted
 * symlink is refused outright rather than followed or silently deleted.
 */
describe('replaceSecretFile — user-named output paths', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-secret-test-'));
    });

    afterEach(() => {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('creates the file when nothing exists at the target', () => {
        const target = path.join(scratchDir, 'out.json');
        replaceSecretFile(target, '{"a":1}');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":1}');
    });

    it('overwrites a pre-existing regular file (re-run semantics)', () => {
        const target = path.join(scratchDir, 'out.json');
        fs.writeFileSync(target, 'old-run');
        replaceSecretFile(target, 'new-run');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new-run');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('refuses to write through a path reported as a symlink (#484) (#757)', () => {
        // A pre-existing regular file stands in for a pre-planted symlink so
        // the assertion is deterministic on every platform/CI environment
        // (this test previously used this.skip() when the environment could
        // not create a real symlink, which --forbid-pending now treats as a
        // hard failure): replaceSecretFile's refusal is driven entirely by
        // fs.lstatSync(...).isSymbolicLink(), so mocking that call to report
        // "yes, a symlink" exercises the exact same guarded branch a real
        // symlink would.
        const link = path.join(scratchDir, 'out.json');
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
 * Direct unit tests for scrubFile (#595): overwrites a secret temp file's
 * content with zeros before cleanupTempFiles() unlinks it, so a crash between
 * the overwrite and the unlink is the only residual-secret window left, for
 * every tracked temp file uniformly (not just the OCI PAR backend config that
 * motivated it).
 */
describe('scrubFile — overwrite-before-unlink content scrub (#595)', function () {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-file-test-'));
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
