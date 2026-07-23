import * as assert from 'assert';
import { buildGitAuthEnv } from '../src/policy-source';

/**
 * Direct unit tests for buildGitAuthEnv (#779) — the per-invocation git config
 * ENV that carries the private-policy-repo clone credential. The credential must
 * ride in GIT_CONFIG_* env (never on argv) AND redirect-following must be
 * disabled so the non-host-scoped Authorization header cannot be forwarded to a
 * cross-host redirect target.
 */
describe('buildGitAuthEnv — credential delivery + redirect scoping (#779)', function () {
    const basic = Buffer.from(':secrettoken').toString('base64');
    const env = buildGitAuthEnv(basic);

    it('delivers the Authorization header via GIT_CONFIG env, not on the command line', function () {
        assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.extraheader');
        assert.strictEqual(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${basic}`);
    });

    it('disables http.followRedirects so the credential cannot be forwarded on a cross-host redirect', function () {
        assert.strictEqual(env.GIT_CONFIG_KEY_1, 'http.followRedirects');
        assert.strictEqual(env.GIT_CONFIG_VALUE_1, 'false');
    });

    it('declares exactly the two config pairs it sets', function () {
        assert.strictEqual(env.GIT_CONFIG_COUNT, '2', 'GIT_CONFIG_COUNT must match the number of KEY/VALUE pairs set');
    });
});
