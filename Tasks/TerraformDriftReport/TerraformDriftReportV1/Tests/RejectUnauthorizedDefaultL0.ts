import { describe, it } from 'mocha';
import assert = require('assert');
import { resolveRejectUnauthorized } from '../src/callback';

// Direct unit tests for the fail-secure resolution of the callback TLS-verify
// flag. tasks.getBoolInput would return false for an absent or blank input — a
// YAML pipeline that omits rejectUnauthorized, since the task.json defaultValue
// only applies in the classic editor — silently turning TLS verification OFF.
// The raw value is read instead and a missing/blank input defaults to secure
// (verify); only an explicit "false" (case-insensitive) disables verification.
describe('drift callback: rejectUnauthorized fail-secure default', () => {
    it('defaults a missing or blank input to true (verify TLS)', () => {
        assert.strictEqual(resolveRejectUnauthorized(undefined), true);
        assert.strictEqual(resolveRejectUnauthorized(''), true);
        assert.strictEqual(resolveRejectUnauthorized('   '), true);
    });

    it('honours an explicit true', () => {
        assert.strictEqual(resolveRejectUnauthorized('true'), true);
        assert.strictEqual(resolveRejectUnauthorized('TRUE'), true);
    });

    it('disables verification only on an explicit false', () => {
        assert.strictEqual(resolveRejectUnauthorized('false'), false);
        assert.strictEqual(resolveRejectUnauthorized('False'), false);
        assert.strictEqual(resolveRejectUnauthorized(' false '), false);
    });

    it('treats any unrecognized value as secure (verify), not as disabled', () => {
        assert.strictEqual(resolveRejectUnauthorized('yes'), true);
        assert.strictEqual(resolveRejectUnauthorized('1'), true);
    });
});
