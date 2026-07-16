import { describe, it } from 'mocha';
import assert = require('assert');
import { resolveFailOnCallbackError } from '../src/callback';

// Direct unit tests for the fail-secure resolution of the callback-failure
// gating flag. Same rationale as RejectUnauthorizedDefaultL0 -- tasks.getBoolInput
// would return false for an absent or blank input (a YAML pipeline that omits
// failOnCallbackError), which would silently flip the task's original
// fail-on-callback-error behavior to non-fatal. The raw value is read instead
// and a missing/blank input defaults to fail-secure (fail); only an explicit
// "false" (case-insensitive) makes a callback failure non-fatal.
describe('drift callback: failOnCallbackError fail-secure default', () => {
    it('defaults a missing or blank input to true (fail the task)', () => {
        assert.strictEqual(resolveFailOnCallbackError(undefined), true);
        assert.strictEqual(resolveFailOnCallbackError(''), true);
        assert.strictEqual(resolveFailOnCallbackError('   '), true);
    });

    it('honours an explicit true', () => {
        assert.strictEqual(resolveFailOnCallbackError('true'), true);
        assert.strictEqual(resolveFailOnCallbackError('TRUE'), true);
    });

    it('disables the failure only on an explicit false', () => {
        assert.strictEqual(resolveFailOnCallbackError('false'), false);
        assert.strictEqual(resolveFailOnCallbackError('False'), false);
        assert.strictEqual(resolveFailOnCallbackError(' false '), false);
    });

    it('treats any unrecognized value as fail-secure (fail), not as disabled', () => {
        assert.strictEqual(resolveFailOnCallbackError('yes'), true);
        assert.strictEqual(resolveFailOnCallbackError('1'), true);
    });
});
