/**
 * CSS-escape / comment-split bypass scenarios (#587): DANGEROUS_CSS_PATTERN is a
 * raw-text blocklist, but a browser's CSS tokenizer decodes escapes and discards
 * comments before a `url()`/`@import` token exists -- so `\75rl(...)`,
 * `@\69mport`, the literal-char escape form `\u\r\l(...)`, and a comment placed
 * between `url` and its `(` all slip past a raw match. sanitizeRenderedHtml (via
 * convertMarkdownToHtml) strips any <style> ELEMENT wholesale, so for this task
 * the exposed surface is the inline `style` ATTRIBUTE; cssHasDangerousConstruct
 * (shared uri-scheme-guard.ts, byte-identical with PublishKbArticle) runs the
 * blocklist the way a browser lexes CSS — comments stripped from the raw bytes
 * FIRST, then that same text escape-decoded — and blocks if either form matches.
 * That ordering also closes the escaped-comment inversion (#587 follow-up): a
 * literal `url(evil)` wrapped in escaped comment delimiters `\2f\2a ... \2a\2f`
 * must NOT be treated as a comment and deleted, because a real browser sees no
 * comment there and fetches it. Split into a self-titled scenario file (#565)
 * matching the sibling tasks' Tests/ convention; mocha only runs Tests/L0.ts,
 * which imports this file.
 */

import assert = require('assert');
import { convertMarkdownToHtml } from '../src/render';
import { cssHasDangerousConstruct } from '../src/uri-scheme-guard';

const BS = '\\'; // a single literal backslash, built without JS-string-escape ambiguity

describe('CSS-escape / comment-split inline-style bypass stripped by sanitizeRenderedHtml (#587)', () => {
    const cases: Array<[string, string]> = [
        ['a hex-escaped url (\\75rl)', `<div style="background:${BS}75rl(https://evil.example.com/x)">x</div>`],
        ['an uppercase/mixed-case hex escape (\\55RL)', `<div style="background:${BS}55RL(https://evil.example.com/x)">x</div>`],
        ['a whitespace-terminated hex escape (\\75 rl)', `<div style="background:${BS}75 rl(https://evil.example.com/x)">x</div>`],
        ['literal-char escapes (\\u\\r\\l)', `<div style="background:${BS}u${BS}r${BS}l(https://evil.example.com/x)">x</div>`],
        ['a comment splitting url from its ( (url/* */()', '<div style="background:url/* x */(https://evil.example.com/x)">x</div>'],
        ['a literal url wrapped in escaped comment delimiters (\\2f\\2a...\\2a\\2f)', `<div style="background:${BS}2f${BS}2a url(https://evil.example.com/x) ${BS}2a${BS}2f">x</div>`],
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

describe('cssHasDangerousConstruct two-pass contract, Markdown2Html copy (#587)', () => {
    // The escaped-comment inversion the #587 follow-up fixes: decode-then-strip
    // would turn \2f\2a ... \2a\2f into CSS comment delimiters and DELETE the live
    // url(evil) between them, passing the gate; a real browser sees no comment
    // there and fetches evil. Comment-first two-pass catches the literal url(.
    it('blocks a literal url() wrapped in escaped comment delimiters (\\2f\\2a ... \\2a\\2f)', () => {
        assert.strictEqual(cssHasDangerousConstruct(`${BS}2f${BS}2a url(https://evil.example.com/x) ${BS}2a${BS}2f`), true);
    });
    it('blocks a hex escape so \\75rl( reads as url(', () => {
        assert.strictEqual(cssHasDangerousConstruct(`background:${BS}75rl(x)`), true);
    });
    it('blocks @\\69mport (decodes to @import)', () => {
        assert.strictEqual(cssHasDangerousConstruct(`@${BS}69mport "x"`), true);
    });
    it('blocks the whitespace-terminated hex escape (\\75 rl -> url)', () => {
        assert.strictEqual(cssHasDangerousConstruct(`${BS}75 rl(`), true);
    });
    it('blocks uppercase/mixed-case and multi-escape forms (\\55RL, \\75\\72\\6C)', () => {
        assert.strictEqual(cssHasDangerousConstruct(`${BS}55RL(`), true);
        assert.strictEqual(cssHasDangerousConstruct(`${BS}75${BS}72${BS}6C(`), true);
    });
    it('blocks the literal-char escape form (\\u\\r\\l -> url)', () => {
        assert.strictEqual(cssHasDangerousConstruct(`${BS}u${BS}r${BS}l(`), true);
    });
    it('blocks a real comment splitting the token (url/* */( , @im/* */port)', () => {
        assert.strictEqual(cssHasDangerousConstruct('url/* x */(https://evil.example.com/x)'), true);
        assert.strictEqual(cssHasDangerousConstruct('@im/* */port "x"'), true);
    });
    it('allows benign escaped content that forms no fetch (content:"\\201C")', () => {
        assert.strictEqual(cssHasDangerousConstruct(`content:"${BS}201C"`), false);
    });
    it('allows benign CSS with a real comment and no fetch construct', () => {
        assert.strictEqual(cssHasDangerousConstruct('/* theme */ body{color:#333;padding:20px}'), false);
    });
});
