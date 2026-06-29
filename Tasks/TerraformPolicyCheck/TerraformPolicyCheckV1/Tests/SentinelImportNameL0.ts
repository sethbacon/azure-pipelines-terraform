import { describe, it } from 'mocha';
import assert = require('assert');
import { validateSentinelImportName } from '../src/sentinel-engine';

// Direct unit tests for sentinel import-name validation. The import name is user
// input (sentinelImportName) embedded verbatim into the generated sentinel.hcl as
// an HCL identifier — import "static" "<name>" { ... }. Unlike the source paths it
// is not string-escaped, so without validation a crafted value could close the
// import block and inject arbitrary config. It must be constrained to a valid
// identifier, which is the only thing Sentinel itself accepts there anyway.
describe('sentinel import-name validation', () => {
    it('accepts valid HCL identifiers (including the tfplan default)', () => {
        assert.strictEqual(validateSentinelImportName('tfplan'), 'tfplan');
        assert.strictEqual(validateSentinelImportName('_plan2'), '_plan2');
        assert.strictEqual(validateSentinelImportName('TF_Plan_v2'), 'TF_Plan_v2');
    });

    it('rejects names that could break out of the HCL import block', () => {
        const rejected = [
            'tfplan" {}\npolicy "evil" { source = "x" }\nimport "static" "x', // injection
            'tfplan-1',  // dash is not an identifier character
            'tf plan',   // whitespace
            '2plan',     // leading digit
            '',          // empty
            'tf$plan',   // shell/HCL metacharacter
        ];
        for (const bad of rejected) {
            assert.throws(
                () => validateSentinelImportName(bad),
                /Invalid sentinelImportName/,
                `expected rejection for: ${JSON.stringify(bad)}`,
            );
        }
    });
});
