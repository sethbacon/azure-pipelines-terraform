import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { neutralizeEnvironmentVariables } from '../src/credential-guards';

/**
 * Severity classification for the credential-neutralizing guard.
 *
 * The guard clears competing credential variables before a handler injects its
 * own, and every branch of it must keep DELETING -- that is the security
 * property, and the rows below assert it for all three classes so a future edit
 * cannot trade the deletion away while chasing quieter logs.
 *
 * What changed, and why it needed tests: the guard used to warn for every name
 * it cleared. `SYSTEM_OIDCREQUESTURI` is set by the agent on EVERY job, so that
 * warning fired on every task of every pipeline -- four times per stage in a
 * plan/apply pipeline -- while reporting nothing an operator could act on. The
 * message names the VARIABLE and never its VALUE, so it read identically for the
 * agent's own endpoint and for a tampered one; it never discriminated, and
 * demoting it removes no detection that existed. Value-level checking is
 * `resolveOidcRequestUrl`'s job and is tested in OidcRequestUrlGuardL0.
 *
 * The classification is the thing most likely to rot, so it is pinned by NAME
 * here rather than by counting output. Moving `SYSTEM_ACCESSTOKEN` into the
 * silent set -- the tempting "these are both SYSTEM_* platform variables"
 * mistake -- fails the second block: the agent does not set it
 * (microsoft/azure-pipelines-agent's EnvironmentCapabilitiesProvider.cs says so
 * in as many words), so its presence IS an operator action worth reporting.
 */
describe('neutralizeEnvironmentVariables — severity classification', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const orig = { warning: t.warning, debug: t.debug };

    let warnings: string[];
    let debugs: string[];

    beforeEach(() => {
        warnings = [];
        debugs = [];
        t.warning = (m: string) => { warnings.push(m); };
        t.debug = (m: string) => { debugs.push(m); };
    });

    afterEach(() => {
        t.warning = orig.warning;
        t.debug = orig.debug;
        for (const n of ['SYSTEM_OIDCREQUESTURI', 'SYSTEM_ACCESSTOKEN', 'ARM_CLIENT_SECRET']) {
            delete process.env[n];
        }
    });

    // --- the security property, asserted for every class ---------------------

    // Deletion is what stops the provider SDK resolving a competing credential
    // ahead of the one this task injected. Severity is presentation; this is the
    // guard. Table-driven so a new class cannot be added without a deletion row.
    for (const name of ['SYSTEM_OIDCREQUESTURI', 'SYSTEM_ACCESSTOKEN', 'ARM_CLIENT_SECRET']) {
        it(`deletes '${name}' from the environment regardless of how it is reported`, () => {
            process.env[name] = 'inherited-value';
            neutralizeEnvironmentVariables([name], 'Azure');
            assert.strictEqual(
                process.env[name], undefined,
                `${name} must be removed from process.env -- it is inherited by the terraform child process`,
            );
        });
    }

    // --- agent-provided: cleared silently -------------------------------------

    it('clears SYSTEM_OIDCREQUESTURI without warning', () => {
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/abc';
        neutralizeEnvironmentVariables(['SYSTEM_OIDCREQUESTURI'], 'Azure');

        assert.deepStrictEqual(
            warnings, [],
            'the agent sets this on every job; warning about it trains operators to ignore warnings. warnings: ' + warnings,
        );
        assert.strictEqual(debugs.length, 1, 'the clear must still be traceable at debug level');
        assert.ok(
            debugs[0].includes('SYSTEM_OIDCREQUESTURI'),
            'the debug line must name the variable that was cleared',
        );
    });

    it('does not print the VALUE of a cleared agent variable', () => {
        // The reason demoting this is safe: the message never carried the value,
        // so it could not distinguish a benign endpoint from a poisoned one. If a
        // future edit adds the value to make the log more useful, it becomes a
        // disclosure and this row fails.
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/SECRET-TENANT';
        neutralizeEnvironmentVariables(['SYSTEM_OIDCREQUESTURI'], 'Azure');
        assert.ok(
            !debugs.concat(warnings).some(m => m.includes('SECRET-TENANT')),
            'neither sink may echo the variable value',
        );
    });

    // --- operator-mapped platform token: warns, but accurately ----------------

    it('warns about SYSTEM_ACCESSTOKEN, which the agent does NOT set', () => {
        process.env['SYSTEM_ACCESSTOKEN'] = 'token';
        neutralizeEnvironmentVariables(['SYSTEM_ACCESSTOKEN'], 'Azure');

        assert.strictEqual(
            warnings.length, 1,
            'a mapped-in platform token is an operator action and must stay reported. warnings: ' + warnings,
        );
    });

    it('does not claim SYSTEM_ACCESSTOKEN selects an identity', () => {
        // It is mapped for REST calls, git push and artifact feeds -- not to pick
        // a cloud identity. The generic message was wrong about it, which is the
        // whole reason it needs its own text.
        process.env['SYSTEM_ACCESSTOKEN'] = 'token';
        neutralizeEnvironmentVariables(['SYSTEM_ACCESSTOKEN'], 'Azure');

        assert.ok(
            !warnings[0].includes('selects a different identity'),
            'inaccurate: this variable does not select a cloud identity. got: ' + warnings[0],
        );
        assert.ok(
            /local-exec|external data source/.test(warnings[0]),
            'the operator needs to know terraform loses it too, not just the provider. got: ' + warnings[0],
        );
    });

    // --- operator-set credentials: unchanged, full warning --------------------

    it('keeps the identity-competition warning for an operator-set credential', () => {
        process.env['ARM_CLIENT_SECRET'] = 'shhh';
        neutralizeEnvironmentVariables(['ARM_CLIENT_SECRET'], 'Azure');

        assert.strictEqual(warnings.length, 1, 'warnings: ' + warnings);
        assert.ok(
            warnings[0].includes('selects a different identity'),
            'this class is exactly what the original warning was for. got: ' + warnings[0],
        );
    });

    // --- absent variables stay silent ----------------------------------------

    it('reports nothing for a variable that was never present', () => {
        delete process.env['ARM_CLIENT_SECRET'];
        neutralizeEnvironmentVariables(['ARM_CLIENT_SECRET'], 'Azure');
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(debugs, []);
    });

    // --- the classification is per-name, not per-prefix -----------------------

    it('classifies the two SYSTEM_* variables differently in one call', () => {
        // The regression this pins: treating them as one family because both
        // start with SYSTEM_. One call, one silent, one warned.
        process.env['SYSTEM_OIDCREQUESTURI'] = 'https://vstoken.dev.azure.com/abc';
        process.env['SYSTEM_ACCESSTOKEN'] = 'token';
        neutralizeEnvironmentVariables(['SYSTEM_ACCESSTOKEN', 'SYSTEM_OIDCREQUESTURI'], 'Azure');

        assert.strictEqual(warnings.length, 1, 'exactly one of the two warrants a warning. warnings: ' + warnings);
        assert.ok(warnings[0].includes('SYSTEM_ACCESSTOKEN'), 'the warned one must be the mapped-in token');
        assert.ok(debugs.some(d => d.includes('SYSTEM_OIDCREQUESTURI')), 'the agent-set one must be debug-only');
    });
});
