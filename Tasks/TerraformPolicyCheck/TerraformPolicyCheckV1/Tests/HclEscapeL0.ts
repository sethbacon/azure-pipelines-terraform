import { describe, it } from 'mocha';
import assert = require('assert');
import { hcl } from '../src/sentinel-engine';

// Direct unit tests for the hcl() escaping helper used when embedding both source
// paths and Sentinel policy names (derived from .sentinel file basenames) into the
// generated sentinel.hcl's double-quoted string labels/values -- e.g.
// `policy "<name>" { source = "<path>" ... }`. Policy names are NOT restricted to
// identifier syntax (unlike sentinelImportName): legitimate filenames commonly use
// dashes (e.g. require-tags.sentinel, deny-public.sentinel -- both used by other
// fixtures in this suite). Backslash and double-quote are escaped so the value
// cannot break out of the quoted string, and `${` / `%{` are escaped to their
// literal HCL forms (`$${` / `%%{`) so template-interpolation syntax in an
// untrusted policy filename is reproduced literally instead of evaluated
// (mirrors TerraformProviderMirror's escapeHclString; #553 sibling).
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

    it('escapes ${ template-interpolation syntax to its literal HCL form (#553 sibling)', () => {
        assert.strictEqual(hcl('${evil}.sentinel'), '$${evil}.sentinel');
    });

    it('escapes %{ template-directive syntax to its literal HCL form (#553 sibling)', () => {
        assert.strictEqual(hcl('%{ if true }x.sentinel'), '%%{ if true }x.sentinel');
    });

    it('escapes a backslash immediately followed by ${ without the passes interfering (#553 sibling)', () => {
        // Raw `\${x}` -> backslash doubled first, then the opener doubled:
        // `\\$${x}`, which HCL decodes back to the literal `\${x}`.
        assert.strictEqual(hcl('\\${x}'), '\\\\$${x}');
    });

    it('doubles an already-doubled opener (input is a literal, not pre-escaped HCL)', () => {
        assert.strictEqual(hcl('$${a}'), '$$${a}');
    });
});
