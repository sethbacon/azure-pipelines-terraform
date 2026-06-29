import * as assert from 'assert';
import { ParentCommandHandler } from '../src/parent-handler';
import { EnvironmentVariableHelper } from '../src/environment-variables';

/**
 * Direct unit test for ParentCommandHandler.emergencyCleanup() before a handler is
 * active. The SIGTERM/SIGINT/uncaughtException handlers call emergencyCleanup(),
 * possibly during execute() before activeHandler is assigned. Tracked credential
 * env vars must still be cleared in that window — clearTrackedVariables() operates
 * on a process-wide static Set and does not depend on a handler — while only the
 * per-handler temp-file cleanup is guarded by an active handler existing.
 */
describe('ParentCommandHandler.emergencyCleanup — no active handler', function () {
    afterEach(() => { EnvironmentVariableHelper.clearTrackedVariables(); });

    it('clears tracked credential env vars even when no handler is active', () => {
        EnvironmentVariableHelper.setEnvironmentVariable('ARM_CLIENT_SECRET', 'super-secret');
        assert.strictEqual(process.env['ARM_CLIENT_SECRET'], 'super-secret');

        // activeHandler is null here because execute() was never called.
        const handler = new ParentCommandHandler();
        assert.doesNotThrow(() => handler.emergencyCleanup());

        assert.strictEqual(
            process.env['ARM_CLIENT_SECRET'], undefined,
            'emergencyCleanup must clear tracked vars before a handler is assigned',
        );
    });
});
