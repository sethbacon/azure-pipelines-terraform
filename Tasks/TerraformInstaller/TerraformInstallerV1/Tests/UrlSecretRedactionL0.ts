import { describe, it } from 'mocha';
import assert = require('assert');
import { extractUrlUserInfoSecrets, redactUrlUserInfo } from '../src/url-secret-redaction';

// Direct (parent-process) unit tests for the operator-URL userinfo redaction
// helpers (#586). These prove the pure parsing/masking logic that the installer
// wiring depends on; the MockTestRunner integration scenarios only assert that the
// wiring calls setSecret and stores a stripped variable, not these edge cases.

describe('url-secret-redaction: redactUrlUserInfo', () => {
    it('strips user:password userinfo, preserving scheme/host/port/path/query', () => {
        assert.strictEqual(
            redactUrlUserInfo('https://user:p%40ss@proxy.corp:8443/terraform/base?x=1'),
            'https://proxy.corp:8443/terraform/base?x=1',
        );
    });

    it('strips a lone token userinfo (no colon)', () => {
        assert.strictEqual(
            redactUrlUserInfo('https://ghp_TOKEN123@mirror.corp/tf'),
            'https://mirror.corp/tf',
        );
    });

    it('is a no-op when there is no userinfo', () => {
        assert.strictEqual(redactUrlUserInfo('https://mirror.corp/tf'), 'https://mirror.corp/tf');
    });

    it('does not treat an @ in the path as userinfo', () => {
        assert.strictEqual(redactUrlUserInfo('https://mirror.corp/tf@v1'), 'https://mirror.corp/tf@v1');
    });

    it('uses the LAST @ in the authority so an @ inside the password is handled', () => {
        assert.strictEqual(
            redactUrlUserInfo('https://user:pa@ss@proxy.corp/tf'),
            'https://proxy.corp/tf',
        );
    });

    it('returns the input unchanged for a non-URL string', () => {
        assert.strictEqual(redactUrlUserInfo('not a url'), 'not a url');
    });
});

describe('url-secret-redaction: extractUrlUserInfoSecrets', () => {
    it('returns the full credential and the password (raw + decoded) when present', () => {
        const secrets = extractUrlUserInfoSecrets('https://user:p%40ss@proxy.corp/tf');
        assert.ok(secrets.includes('user:p%40ss'), 'the whole user:password substring should be masked');
        assert.ok(secrets.includes('p%40ss'), 'the raw (encoded) password should be masked');
        assert.ok(secrets.includes('p@ss'), 'the decoded password should also be masked');
    });

    it('does NOT mask a benign username on its own when a password is present', () => {
        const secrets = extractUrlUserInfoSecrets('https://admin:secret@proxy.corp/tf');
        assert.ok(!secrets.includes('admin'), 'a bare username must not be registered as a secret (over-redaction)');
        assert.ok(secrets.includes('secret'), 'the password must be masked');
        assert.ok(secrets.includes('admin:secret'), 'the full credential substring must be masked');
    });

    it('masks a lone token userinfo whole', () => {
        const secrets = extractUrlUserInfoSecrets('https://ghp_TOKEN123@mirror.corp/tf');
        assert.ok(secrets.includes('ghp_TOKEN123'), 'a lone userinfo token must be masked');
    });

    it('returns empty when there is no userinfo', () => {
        assert.deepStrictEqual(extractUrlUserInfoSecrets('https://mirror.corp/tf'), []);
        assert.deepStrictEqual(extractUrlUserInfoSecrets('https://mirror.corp/tf@v1'), []);
    });
});
