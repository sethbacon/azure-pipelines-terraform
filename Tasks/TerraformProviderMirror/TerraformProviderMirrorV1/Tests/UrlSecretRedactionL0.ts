import { describe, it } from 'mocha';
import assert = require('assert');
import {
    extractUrlTokenSecrets,
    redactUrl,
    scrubSecretsFromMessage,
    extractUrlUserInfoSecrets,
    redactUrlUserInfo,
} from '../src/url-secret-redaction';

/**
 * Direct unit tests for the shared url-secret-redaction module (#776). This file
 * is byte-identical across the four tasks that consume the module — the three
 * installer tasks (Terraform, terraform-docs, policy-agent) and
 * TerraformProviderMirror — mirroring the module itself, which is a byte-identical
 * parity family gated by scripts/check-shared-modules.js and held to the
 * SECURITY_FLOOR (plus the #777 functions/branches floors) by
 * scripts/check-per-file-coverage.js. Exercising the whole module DIRECTLY here
 * (not only through each task's own download/mirror integration scenarios) keeps
 * every copy's per-file coverage uniformly high, so a credential-redaction
 * regression can't slip through a task whose integration scenarios happen to
 * exercise fewer of these branches.
 */
describe('url-secret-redaction', () => {
    describe('extractUrlTokenSecrets', () => {
        it('returns empty for a URL with no query string', () => {
            assert.deepStrictEqual(extractUrlTokenSecrets('https://host/path'), []);
        });

        it('extracts Azure sig, AWS and GCS signature/credential/token values', () => {
            const url = 'https://host/blob?sig=AZSIG&X-Amz-Signature=AWSSIG&X-Amz-Credential=AWSCRED&X-Goog-Signature=GSIG&custom_token=TOK&plain=keep';
            const secrets = extractUrlTokenSecrets(url);
            assert.deepStrictEqual(secrets, ['AZSIG', 'AWSSIG', 'AWSCRED', 'GSIG', 'TOK']);
            assert.ok(!secrets.includes('keep'), 'non-sensitive params must not be extracted');
        });

        it('adds the percent-decoded form when it differs from the raw value', () => {
            const secrets = extractUrlTokenSecrets('https://host/p?sig=a%2Fb');
            assert.deepStrictEqual(secrets, ['a%2Fb', 'a/b']);
        });

        it('keeps only the raw form when percent-decoding fails', () => {
            const secrets = extractUrlTokenSecrets('https://host/p?sig=bad%ZZenc');
            assert.deepStrictEqual(secrets, ['bad%ZZenc']);
        });

        it('ignores empty values, pairs without "=", and anything after a fragment', () => {
            const secrets = extractUrlTokenSecrets('https://host/p?sig=&flag&token=T#sig=FRAG');
            assert.deepStrictEqual(secrets, ['T']);
        });
    });

    describe('redactUrl', () => {
        it('drops the entire query string, keeping origin and path', () => {
            assert.strictEqual(
                redactUrl('https://host:8443/a/b?sig=SECRET&x=1'),
                'https://host:8443/a/b?<redacted>'
            );
        });

        it('returns origin+path unchanged when there is no query', () => {
            assert.strictEqual(redactUrl('https://host/a/b'), 'https://host/a/b');
        });

        it('falls back to a split at "?" for an unparseable URL', () => {
            assert.strictEqual(redactUrl('not a url?sig=SECRET'), 'not a url');
        });
    });

    describe('scrubSecretsFromMessage', () => {
        it('replaces the raw URL with its redacted form and masks each secret', () => {
            const url = 'https://host/blob?sig=SECRET';
            const scrubbed = scrubSecretsFromMessage(
                `download of ${url} failed; server said sig=SECRET invalid`,
                url,
                ['SECRET']
            );
            assert.strictEqual(
                scrubbed,
                'download of https://host/blob?<redacted> failed; server said sig=<redacted> invalid'
            );
        });
    });

    describe('extractUrlUserInfoSecrets', () => {
        it('returns empty for a URL without userinfo or without a scheme', () => {
            assert.deepStrictEqual(extractUrlUserInfoSecrets('https://host/path'), []);
            assert.deepStrictEqual(extractUrlUserInfoSecrets('host/user@path'), []);
        });

        it('masks the user:password pair and the password alone', () => {
            assert.deepStrictEqual(
                extractUrlUserInfoSecrets('https://admin:hunter2@mirror.internal/providers'),
                ['admin:hunter2', 'hunter2']
            );
        });

        it('adds percent-decoded forms when they differ', () => {
            assert.deepStrictEqual(
                extractUrlUserInfoSecrets('https://u:p%40ss@host/'),
                ['u:p%40ss', 'u:p@ss', 'p%40ss', 'p@ss']
            );
        });

        it('treats a lone userinfo with no colon as a whole token', () => {
            assert.deepStrictEqual(extractUrlUserInfoSecrets('https://apitoken@host/'), ['apitoken']);
        });

        it('splits user from password at the LAST @ of the authority (matching WHATWG)', () => {
            assert.deepStrictEqual(
                extractUrlUserInfoSecrets('https://u:p@ss@host/x'),
                ['u:p@ss', 'p@ss']
            );
        });

        it('does not read an @ that appears only in the path as userinfo', () => {
            assert.deepStrictEqual(extractUrlUserInfoSecrets('https://host/a@b'), []);
        });
    });

    describe('redactUrlUserInfo', () => {
        it('strips the userinfo but preserves scheme, host, port, path and query', () => {
            assert.strictEqual(
                redactUrlUserInfo('https://admin:hunter2@mirror.internal:8443/p?x=1'),
                'https://mirror.internal:8443/p?x=1'
            );
        });

        it('returns the URL unchanged when there is no userinfo', () => {
            assert.strictEqual(redactUrlUserInfo('https://host/p'), 'https://host/p');
        });

        it('returns a scheme-less string unchanged', () => {
            assert.strictEqual(redactUrlUserInfo('host/p@x'), 'host/p@x');
        });
    });
});
