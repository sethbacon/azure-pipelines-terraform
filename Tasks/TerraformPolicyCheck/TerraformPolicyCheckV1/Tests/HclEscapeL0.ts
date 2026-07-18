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
// cannot break out of the quoted string, `${` / `%{` are escaped to their literal
// HCL forms (`$${` / `%%{`) so template-interpolation syntax in an untrusted
// policy filename is reproduced literally instead of evaluated, and CR/LF are
// escaped to a literal `\n` so an embedded newline (valid in a filename on
// Linux/macOS) can't produce a raw multi-line string (mirrors
// TerraformProviderMirror's escapeHclString; #553 sibling, #648).
describe('hcl() escaping for policy names and paths', () => {
    it('passes common filename characters through unchanged', () => {
        assert.strictEqual(hcl('require-tags'), 'require-tags');
        assert.strictEqual(hcl('deny-public'), 'deny-public');
        assert.strictEqual(hcl('policy_v2.1'), 'policy_v2.1');
    });

    it('escapes an embedded double-quote so it cannot close the HCL string', () => {
        const escaped = hcl('evil" { source = "x" }\npolicy "injected');
        assert.strictEqual(escaped, 'evil\\" { source = \\"x\\" }\\npolicy \\"injected');
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

    // #648: a hostile policy filename (reachable when policySource=gitUrl points
    // at a third-party policy repo) can carry a literal newline on Linux/macOS.
    // Escape CR/LF to a literal `\n` so the generated `policy "<name>" { ... }`
    // label stays on one well-formed HCL line, mirroring
    // TerraformProviderMirror's escapeHclString (#553 sibling).
    it('escapes an embedded LF to a literal \\n (#648)', () => {
        assert.strictEqual(hcl('evil\npolicy "injected"'), 'evil\\npolicy \\"injected\\"');
    });

    it('escapes an embedded CRLF to a single literal \\n, not two (#648)', () => {
        assert.strictEqual(hcl('evil\r\nnext-line'), 'evil\\nnext-line');
    });

    it('escapes a lone embedded CR to a literal \\n (#648)', () => {
        assert.strictEqual(hcl('evil\rnext-line'), 'evil\\nnext-line');
    });

    it('a hostile filename with a newline, quote, and injection attempt renders as one well-formed HCL line (#648)', () => {
        const hostile = 'evil"\n}\npolicy "injected" {\n  source = "*';
        const escaped = hcl(hostile);

        // No raw CR/LF survives, and the value stays interpolable on a single line.
        assert.ok(!/[\r\n]/.test(escaped), 'no raw newline should remain in the escaped value');
        const rebuilt = `policy "${escaped}" {`;
        assert.ok(!/[\r\n]/.test(rebuilt), 'the rebuilt HCL policy label must be a single line');

        // Exactly one opening and one closing (unescaped) quote survive -- the
        // crafted quotes inside no longer terminate the string early.
        const unescapedQuoteCount = (rebuilt.match(/(?<!\\)"/g) || []).length;
        assert.strictEqual(unescapedQuoteCount, 2);
    });
});
