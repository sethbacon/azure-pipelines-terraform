import tasks = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import cp = require('child_process');
import os = require('os');

/**
 * Write sensitive content to a file with restrictive permissions.
 * The write is exclusive (O_EXCL, flag 'wx'): if anything already exists at
 * the target path -- including a pre-planted symlink, which a plain write
 * would follow -- the write fails instead of being redirected (CWE-59 /
 * CWE-377), mirroring TerraformDriftReport's hardened summary write.
 * Uses mode 0o600 on Unix (fail closed if chmod fails); on Windows, where
 * POSIX modes are a no-op, an explicit restrictive DACL is applied instead
 * (inheritance removed, only the current user granted), also fail closed.
 */
export function writeSecretFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, { mode: 0o600, flag: 'wx' });
    // The credential file now exists on disk. The permission-hardening below is
    // deliberately fail-closed (it throws on a chmod failure on Unix, or an
    // icacls/DACL failure on Windows), but every call site registers the path
    // for scrub+cleanup only on the line *after* this returns -- so a throw here
    // would otherwise leave the file orphaned on disk with weaker-than-intended
    // permissions AND untracked, defeating cleanupTempFiles()/emergencyCleanup()
    // (#634). Scrub-then-remove it before re-throwing (mirroring
    // cleanupTempFiles' scrub-then-unlink) so a hardening failure never leaves a
    // readable credential behind, independent of how the caller tracks it.
    try {
        try {
            fs.chmodSync(filePath, 0o600);
        } catch (err) {
            if (process.platform !== 'win32') {
                throw new Error(`Failed to set restrictive permissions on ${filePath}: ${err instanceof Error ? err.message : err}`);
            }
            tasks.debug('Skipping chmod on Windows platform (a restrictive DACL is applied instead).');
        }
        if (process.platform === 'win32') {
            applyWindowsRestrictiveAcl(filePath);
        }
    } catch (hardenErr) {
        // Best-effort scrub then remove; each guarded independently so a scrub
        // failure still lets the unlink run. The original hardening error is the
        // one propagated -- the fail-closed task failure is preserved.
        try { scrubFile(filePath); } catch { /* best-effort: may be unreadable */ }
        try { fs.unlinkSync(filePath); } catch { /* best-effort: may already be gone */ }
        throw hardenErr;
    }
}

/**
 * Write sensitive content to a *user-named, predictable* path (the
 * show/output/custom command output files), where a re-run legitimately
 * overwrites a previous run's file. A pre-existing regular file is unlinked
 * first and the content is then exclusively re-created via writeSecretFile
 * (so the open itself can never follow a symlink); a pre-existing symlink is
 * refused outright rather than silently followed or deleted, since a symlink
 * sitting at a path this task is about to fill with potentially sensitive
 * output is never legitimate (CWE-59).
 */
export function replaceSecretFile(filePath: string, content: string): void {
    let existing: fs.Stats | undefined;
    try {
        existing = fs.lstatSync(filePath);
    } catch {
        // Nothing at the target path -- fall through to the exclusive create.
    }
    if (existing) {
        if (existing.isSymbolicLink()) {
            throw new Error(`Refusing to write ${filePath}: a symbolic link already exists at that path.`);
        }
        fs.unlinkSync(filePath);
    }
    writeSecretFile(filePath, content);
}

/**
 * mode 0o600 is ignored on Windows, so a freshly written credential file
 * otherwise inherits whatever ACL its directory carries -- on a shared
 * self-hosted agent that can include broad read grants such as
 * BUILTIN\Users. Mirror the Unix 0600 guarantee with an explicit DACL:
 * strip inherited ACEs, grant the current user, and remove the broad
 * low-privilege principals (Everyone, BUILTIN\Users, Authenticated Users,
 * Guests) by well-known SID -- some Windows builds convert inherited ACEs to
 * explicit ones on `/inheritance:r` instead of dropping them, so the removals
 * make the outcome deterministic (SIDs, not names, so this is
 * locale-independent; removing an absent principal is a no-op).
 * NT AUTHORITY\SYSTEM and BUILTIN\Administrators are deliberately not
 * removed where a machine stamps them explicitly: they are the Windows
 * equivalent of root, which Unix 0600 does not (and cannot) exclude either.
 * Fails closed, like the Unix chmod branch: icacls is a base Windows
 * component present on every supported agent, so a failure here means the
 * restriction genuinely could not be applied and the file must not be
 * trusted as private.
 */
function applyWindowsRestrictiveAcl(filePath: string): void {
    const userName = process.env['USERNAME'] || os.userInfo().username;
    const account = process.env['USERDOMAIN'] ? `${process.env['USERDOMAIN']}\\${userName}` : userName;
    try {
        cp.execFileSync('icacls', [
            filePath,
            '/inheritance:r',
            '/grant:r', `${account}:F`,
            '/remove:g', '*S-1-1-0',      // Everyone
            '/remove:g', '*S-1-5-32-545', // BUILTIN\Users
            '/remove:g', '*S-1-5-11',     // Authenticated Users
            '/remove:g', '*S-1-5-32-546', // Guests
        ], { stdio: 'pipe' });
    } catch (err) {
        throw new Error(`Failed to set restrictive ACL on ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * Overwrites a secret temp file's on-disk content with zeros before it is
 * unlinked. Terraform WIF token/credential files (OIDC JWTs, GCP/OCI
 * credential JSON, PEM keys, the OCI PAR backend config-<uuid>.tf, cleartext
 * `terraform output -json` dumps, ...) are all restrictively-permissioned and
 * tracked for end-of-step deletion, but a bare unlink only removes the
 * directory entry -- the bytes can remain recoverable on disk (a raw-device
 * read, a filesystem that doesn't zero freed blocks, a crash-consistent
 * snapshot taken between write and delete) until overwritten. Scrubbing first
 * shrinks that residual-secret window down to only a crash between the
 * overwrite and the unlink itself (#595). Best-effort and silent on a
 * already-missing file (nothing to scrub); the caller decides how to react to
 * any other failure (e.g. a permissions error), matching every other
 * fail-aware primitive in this module. Not meaningful defense against a
 * copy-on-write or log-structured filesystem/SSD wear-leveling remap, which
 * can retain the pre-overwrite blocks regardless -- this narrows the ordinary
 * case, not every storage layer.
 *
 * The file is opened first (a plain open, which on Windows follows a
 * symlink -- Node's O_NOFOLLOW is not honored there, confirmed empirically:
 * it silently follows rather than erroring), and only AFTER that is the path
 * separately lstat'd to check whether it is currently a symlink. Ordering the
 * check after the open (rather than the more obvious lstat-then-open) avoids
 * a check-then-use race window (CWE-367): whatever the open captured is a
 * fixed reference that a later path swap cannot retarget, so the subsequent
 * lstat only ever has to answer "was this path a symlink going into (or
 * immediately after) the open" -- if so, the descriptor is closed WITHOUT
 * writing through it, so a tracked path swapped for a symlink onto a victim
 * file (e.g. an attacker racing a shared working directory between write and
 * cleanup) is never scrubbed, matching the symlink-refusal idiom
 * `replaceSecretFile` already uses (CWE-59). The worst case on a benign race
 * (the path is legitimately replaced/removed between the open and the lstat)
 * is a missed scrub, never a wrong-target write -- the correct fail-closed
 * tradeoff for a security-sensitive scrub. `cleanupTempFiles()` still unlinks
 * the link entry itself; only the content-overwrite is skipped here.
 */
export function scrubFile(filePath: string): void {
    let fd: number;
    try {
        fd = fs.openSync(filePath, 'r+');
    } catch {
        return; // Nothing at this path to scrub.
    }
    try {
        let linkCheck: fs.Stats;
        try {
            linkCheck = fs.lstatSync(filePath);
        } catch {
            return; // Path no longer resolves -- do not write through a stale descriptor.
        }
        if (linkCheck.isSymbolicLink()) return; // Never write through a (possibly just-followed) symlink.

        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return; // Not a regular file -- never written through.
        if (stat.size === 0) return;
        fs.writeSync(fd, Buffer.alloc(stat.size, 0), 0, stat.size, 0);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Chmods an existing file to 0600 after the fact. Unlike writeSecretFile
 * (which controls the initial write), this is for files this task did not
 * write itself -- e.g. a secure file downloaded by the third-party
 * azure-pipelines-tasks-securefiles-common helper, which applies its own
 * (often less restrictive) default permissions. On Windows, where the 0600
 * mode is a no-op, the same explicit restrictive DACL writeSecretFile uses is
 * applied instead (fail closed) -- otherwise the downloaded file would keep
 * whatever ACL its directory hands out.
 */
export function tightenFilePermissions(filePath: string): void {
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (err) {
        if (process.platform !== 'win32') {
            throw new Error(`Failed to set restrictive permissions on ${filePath}: ${err instanceof Error ? err.message : err}`);
        }
        tasks.debug('Skipping chmod on Windows platform (a restrictive DACL is applied instead).');
    }
    if (process.platform === 'win32') {
        applyWindowsRestrictiveAcl(filePath);
    }
}
