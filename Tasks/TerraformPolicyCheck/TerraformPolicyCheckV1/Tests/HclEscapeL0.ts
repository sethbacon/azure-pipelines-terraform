import { describe, it } from 'mocha';
import assert = require('assert');
import { hcl } from '../src/sentinel-engine';

// Direct unit tests for the hcl() escaping helper used when embedding both source
// paths and Sentinel policy names (derived from .sentinel file basenames) into the
// generated sentinel.hcl's double-quoted string labels/values -- e.g.
// `policy "<name>" { source = "<path>" ... }`. Policy names are NOT restricted to
// identifier syntax (unlike sentinelImportName): legitimate filenames commonly use
// dashes (e.g. require-tags.sentinel, deny-public.sentinel -- both used by other
// fixtures in this suite), so only the characters that are actually unsafe inside
// an HCL quoted string (backslash and double-quote) need escaping.
describe('hcl() escaping for policy names and paths', () => {
    it('passes common filename characters through unchanged', () => {
        assert.strictEqual(hcl('require-tags'), 'require-tags');
        assert.strictEqual(hcl('deny-public'), 'deny-public');
        assert.strictEqual(hcl('policy_v2.1'), 'policy_v2.1');
    });

    it('escapes an embedded double-quote so it cannot close the HCL string', () => {
        const escaped = hcl('evil" { source = "x" }\npolicy "injected');
        assert.strictEqual(escaped, 'evil\\" { source = \\"x\\" }\npolicy \\"injected');
        // Re-embedding the escaped value in a quoted HCL string yields exactly one
        // opening and one closing (unescaped) quote -- the crafted quotes inside no
        // longer terminate the string early.
        const rebuilt = `policy "${escaped}" {`;
        const unescapedQuoteCount = (rebuilt.match(/(?<!\\)"/g) || []).length;
        assert.strictEqual(unescapedQuoteCount, 2);
    });

    it('escapes an embedded backslash', () => {
        assert.strictEqual(hcl('a\\b'), 'a\\\\b');
    });
});
