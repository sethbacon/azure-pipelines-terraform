import * as assert from 'assert';
import fs = require('fs');
import { tightenFilePermissions } from '../src/secure-temp';

/**
 * Direct unit tests for tightenFilePermissions (#355): chmods a file already
 * on disk (e.g. one downloaded by a third-party library) to 0600, matching
 * writeSecretFile's platform-aware fail-closed/Windows-swallow behavior.
 */
describe('tightenFilePermissions — post-hoc chmod for third-party downloads', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared fs module
    const f = fs as any;
    const origChmodSync = f.chmodSync;
    const origPlatform = process.platform;

    afterEach(() => {
        f.chmodSync = origChmodSync;
        Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('chmods the file to 0600 when chmod succeeds', () => {
        let calledWith: unknown[] | undefined;
        f.chmodSync = (...args: unknown[]) => { calledWith = args; };
        tightenFilePermissions('/tmp/downloaded-secure-file-does-not-matter.txt');
        assert.deepStrictEqual(calledWith, ['/tmp/downloaded-secure-file-does-not-matter.txt', 0o600]);
    });

    it('re-throws when chmod fails on a non-Windows platform (fail closed)', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        f.chmodSync = () => { throw new Error('EPERM'); };
        assert.throws(
            () => tightenFilePermissions('/tmp/downloaded-secure-file.txt'),
            /Failed to set restrictive permissions/,
        );
    });

    it('swallows a chmod failure on Windows (ACLs apply instead)', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        f.chmodSync = () => { throw new Error('not supported'); };
        assert.doesNotThrow(() => tightenFilePermissions('/tmp/downloaded-secure-file.txt'));
    });
});
