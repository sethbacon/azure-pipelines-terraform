/**
 * CSS-escape / comment-split bypass scenarios (#587): DANGEROUS_CSS_PATTERN is a
 * raw-text blocklist, but a browser's CSS tokenizer decodes escapes and discards
 * comments before a `url()`/`@import` token exists -- so `\75rl(...)`,
 * `@\69mport`, the literal-char escape form `\u\r\l(...)`, and a comment placed
 * between `url` and its `(` all slip past a raw match. sanitizeRenderedHtml (via
 * convertMarkdownToHtml) strips any <style> ELEMENT wholesale, so for this task
 * the exposed surface is the inline `style` ATTRIBUTE; normalizeCssForDangerCheck
 * (shared uri-scheme-guard.ts, byte-identical with PublishKbArticle) decodes +
 * strips before the pattern runs. Split into a self-titled scenario file (#565)
 * matching the sibling tasks' Tests/ convention; mocha only runs Tests/L0.ts,
 * which imports this file.
 */

import assert = require('assert');
import { convertMarkdownToHtml } from '../src/render';
import { normalizeCssForDangerCheck, DANGEROUS_CSS_PATTERN } from '../src/uri-scheme-guard';

const BS = '\\'; // a single literal backslash, built without JS-string-escape ambiguity

describe('CSS-escape / comment-split inline-style bypass stripped by sanitizeRenderedHtml (#587)', () => {
    const cases: Array<[string, string]> = [
        ['a hex-escaped url (\\75rl)', `<div style="background:${BS}75rl(https://evil.example.com/x)">x</div>`],
        ['an uppercase/mixed-case hex escape (\\55RL)', `<div style="background:${BS}55RL(https://evil.example.com/x)">x</div>`],
        ['a whitespace-terminated hex escape (\\75 rl)', `<div style="background:${BS}75 rl(https://evil.example.com/x)">x</div>`],
        ['literal-char escapes (\\u\\r\\l)', `<div style="background:${BS}u${BS}r${BS}l(https://evil.example.com/x)">x</div>`],
        ['a comment splitting url from its ( (url/* */()', '<div style="background:url/* x */(https://evil.example.com/x)">x</div>'],
    ];
    for (const [label, md] of cases) {
        it(`strips an inline style attribute using ${label}`, () => {
            const html = convertMarkdownToHtml(md);
            assert.ok(!/style\s*=/i.test(html), `the dangerous inline style must be stripped (got: ${html})`);
        });
    }

    it('preserves a benign inline style attribute (no over-stripping)', () => {
        const html = convertMarkdownToHtml('<div style="color:red;text-align:center">x</div>');
        assert.ok(/style\s*=/i.test(html), `a benign inline style should survive (got: ${html})`);
    });
});

describe('normalizeCssForDangerCheck decoding contract, Markdown2Html copy (#587)', () => {
    it('decodes a hex escape so \\75rl( reads as url(', () => {
        assert.match(normalizeCssForDangerCheck(`background:${BS}75rl(x)`), /url\(/);
    });
    it('decodes @\\69mport to @import', () => {
        assert.match(normalizeCssForDangerCheck(`@${BS}69mport "x"`), /@import/);
    });
    it('consumes the single whitespace terminator after a hex escape (\\75 rl -> url)', () => {
        assert.strictEqual(normalizeCssForDangerCheck(`${BS}75 rl(`), 'url(');
    });
    it('decodes uppercase/mixed-case and multi-escape forms (\\55RL, \\75\\72\\6C)', () => {
        assert.strictEqual(normalizeCssForDangerCheck(`${BS}55RL(`), 'URL(');
        assert.strictEqual(normalizeCssForDangerCheck(`${BS}75${BS}72${BS}6C(`), 'url(');
    });
    it('decodes the literal-char escape form (\\u\\r\\l -> url)', () => {
        assert.strictEqual(normalizeCssForDangerCheck(`${BS}u${BS}r${BS}l(`), 'url(');
    });
    it('strips a comment splitting the token (url/* */( -> url(, @im/* */port -> @import)', () => {
        assert.strictEqual(normalizeCssForDangerCheck('url/* x */('), 'url(');
        assert.strictEqual(normalizeCssForDangerCheck('@im/* */port'), '@import');
    });
    it('does not synthesize a blocked token from benign escaped content (content:"\\201C")', () => {
        assert.doesNotMatch(normalizeCssForDangerCheck(`content:"${BS}201C"`), /url\(|@import/);
    });
});
