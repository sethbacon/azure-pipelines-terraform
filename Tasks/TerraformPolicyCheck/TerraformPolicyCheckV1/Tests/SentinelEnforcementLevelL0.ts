import { describe, it } from 'mocha';
import assert = require('assert');
import { validateEnforcementLevel } from '../src/sentinel-engine';

// Direct unit tests for enforcement-level validation. The level is user input
// (defaultEnforcementLevel) embedded verbatim into the generated sentinel.hcl as
// a quoted HCL string — `enforcement_level = "<level>"`. ADO does not enforce
// picklist values at runtime, and unlike the source paths this field is not
// escaped via hcl(), so it must be constrained to the exact enum Sentinel
// itself recognizes for that setting.
describe('sentinel enforcement-level validation', () => {
    it('accepts the three valid enforcement levels', () => {
        assert.strictEqual(validateEnforcementLevel('advisory'), 'advisory');
        assert.strictEqual(validateEnforcementLevel('soft-mandatory'), 'soft-mandatory');
        assert.strictEqual(validateEnforcementLevel('hard-mandatory'), 'hard-mandatory');
    });

    it('rejects values that could break out of the quoted HCL string', () => {
        const rejected = [
            'advisory"\nmalicious',   // injection via embedded quote/newline
            'HARD-MANDATORY',        // wrong case
            'soft',                  // not a full valid value
            '',                      // empty
        ];
        for (const bad of rejected) {
            assert.throws(
                () => validateEnforcementLevel(bad),
                /Invalid defaultEnforcementLevel/,
                `expected rejection for: ${JSON.stringify(bad)}`,
            );
        }
    });
});
