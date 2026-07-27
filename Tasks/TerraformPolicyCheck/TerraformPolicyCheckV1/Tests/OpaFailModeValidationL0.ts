import { describe, it } from 'mocha';
import assert = require('assert');
import { validateFailMode } from '../src/opa-engine';

// Direct unit tests for failMode validation (#827). failMode selects which shape
// extractViolations expects from the OPA decision (a collection of violations vs.
// a defined/truthy scalar). ADO does not enforce picklist values at runtime, and
// an unrecognized value previously fell through silently to the 'nonEmpty' branch
// -- so a typo'd failMode could pass a scalar-decision policy that was never
// actually evaluated as intended, opening the gate rather than failing loudly.
// Mirrors sentinel-engine.ts's validateEnforcementLevel reject-path test.
describe('OPA failMode validation', () => {
  it('accepts the two recognized failMode values unchanged', () => {
    assert.strictEqual(validateFailMode('nonEmpty'), 'nonEmpty');
    assert.strictEqual(validateFailMode('defined'), 'defined');
  });

  it('rejects any value outside the recognized set', () => {
    const rejected = [
      'Defined',     // wrong case
      'nonempty',    // wrong case
      'NonEmpty',    // wrong case
      'bogus',       // unknown value
      '',            // empty
      'nonEmpty ',   // trailing whitespace
    ];
    for (const bad of rejected) {
      assert.throws(
        () => validateFailMode(bad),
        /Invalid failMode/,
        `expected rejection for: ${JSON.stringify(bad)}`,
      );
    }
  });
});
