/**
 * Allowlist-sanitizer scenarios (#552): sanitizeRenderedHtml's primary defense is
 * now a vetted ALLOWLIST sanitizer (sanitize-html) rather than the historically-
 * bypassed hand-rolled denylist. Two groups of tests:
 *
 *   1. CONTENT FIDELITY — representative real-world markdown (tables with column
 *      alignment, syntax-highlighted code, images, links, lists, blockquotes,
 *      inline formatting) must survive the allowlist byte-stably, verified
 *      structurally through cheerio so serialization normalization (e.g. `<br>` ->
 *      `<br />`) is not spuriously flagged.
 *   2. ALLOWLIST INVERSION — a tag that is neither dangerous nor allowlisted is now
 *      DROPPED (the old denylist kept everything it did not explicitly block); its
 *      inert text content is preserved. This is the behavior change the inversion
 *      buys: unknown/active elements fail closed instead of fail open, and the
 *      foreign-content namespaces (<svg>/<math>) the mXSS class rides on are
 *      dropped at the root — a documented, security-motivated normalization of
 *      raw author-supplied inline SVG/MathML (markdown-it never emits either).
 *
 * Split into a self-titled scenario file (#565) matching the sibling tasks' Tests/
 * convention; mocha only runs Tests/L0.ts, which imports this file.
 */

import assert = require('assert');
import * as cheerio from 'cheerio';
import { convertMarkdownToHtml } from '../src/render';

describe('Allowlist sanitizer — content fidelity (#552)', () => {
    it('preserves GFM table structure and per-column text-align styles', () => {
        const md = '| Left | Right |\n|:-----|------:|\n| a    | b     |\n';
        const $ = cheerio.load(convertMarkdownToHtml(md));
        assert.strictEqual($('table').length, 1, 'table element preserved');
        assert.strictEqual($('th').length, 2, 'both header cells preserved');
        // markdown-it emits inline text-align styles for aligned columns; the
        // allowlist keeps the style attribute and the guard pass leaves a benign
        // (no url()/@import) value intact.
        const headerStyles = $('th').map((_, el) => $(el).attr('style') ?? '').get().join('|');
        assert.ok(/text-align:\s*left/.test(headerStyles), `left alignment preserved (got: ${headerStyles})`);
        assert.ok(/text-align:\s*right/.test(headerStyles), `right alignment preserved (got: ${headerStyles})`);
    });

    it('preserves highlight.js code-block classes and token spans', () => {
        const $ = cheerio.load(convertMarkdownToHtml('```js\nconst x = 1;\n```'));
        assert.strictEqual($('pre code.hljs').length, 1, 'hljs code container preserved');
        assert.ok($('pre code').hasClass('language-js'), 'language class preserved');
        assert.ok($('span.hljs-keyword').length >= 1, 'highlighted token span preserved');
    });

    it('preserves image src/alt/title', () => {
        const $ = cheerio.load(convertMarkdownToHtml('![the alt](https://example.com/pic.png "the title")'));
        const img = $('img');
        assert.strictEqual(img.length, 1, 'image preserved');
        assert.strictEqual(img.attr('src'), 'https://example.com/pic.png', 'src preserved');
        assert.strictEqual(img.attr('alt'), 'the alt', 'alt preserved');
        assert.strictEqual(img.attr('title'), 'the title', 'title preserved');
    });

    it('preserves link href/title and a fragment link', () => {
        const $ = cheerio.load(convertMarkdownToHtml('[docs](https://example.com/docs "hover") and [top](#top)'));
        const links = $('a');
        assert.strictEqual(links.length, 2, 'both links preserved');
        assert.strictEqual($('a').first().attr('href'), 'https://example.com/docs', 'external href preserved');
        assert.strictEqual($('a').first().attr('title'), 'hover', 'link title preserved');
        assert.strictEqual($('a').last().attr('href'), '#top', 'fragment href preserved');
    });

    it('preserves lists, blockquotes and inline formatting (em/strong/strikethrough/code)', () => {
        const md = [
            '> a quote',
            '',
            '- bullet one',
            '- bullet two',
            '',
            '1. step one',
            '2. step two',
            '',
            'Some **bold**, _italic_, ~~struck~~ and `inline code`.',
        ].join('\n');
        const $ = cheerio.load(convertMarkdownToHtml(md));
        assert.strictEqual($('blockquote').length, 1, 'blockquote preserved');
        assert.strictEqual($('ul li').length, 2, 'bullet items preserved');
        assert.strictEqual($('ol li').length, 2, 'numbered items preserved');
        assert.strictEqual($('strong').length, 1, 'strong preserved');
        assert.strictEqual($('em').length, 1, 'em preserved');
        assert.strictEqual($('s').length, 1, 'strikethrough preserved');
        assert.ok($('p code').length >= 1, 'inline code preserved');
    });

    it('preserves an author-written inert <div class> and a <br> inside a table cell', () => {
        const md = '<div class="note">note text</div>\n\n| A | B |\n|---|---|\n| 1<br>2 | 3 |\n';
        const $ = cheerio.load(convertMarkdownToHtml(md));
        assert.strictEqual($('div.note').length, 1, 'inert div with class preserved');
        assert.strictEqual($('div.note').text(), 'note text', 'div content preserved');
        assert.ok($('td br').length >= 1, '<br> inside a table cell preserved');
    });
});

describe('Allowlist sanitizer — inversion / normalization (#552)', () => {
    it('drops a non-dangerous but non-allowlisted element while keeping its inert text', () => {
        // <marquee> is not in the historical DANGEROUS_TAGS denylist, so the old
        // sanitizer KEPT it; the allowlist does not list it, so it is dropped and
        // only its text content remains.
        const html = convertMarkdownToHtml('Before\n\n<marquee>scrolling text</marquee>\n\nAfter');
        assert.ok(!/<marquee[\s>]/i.test(html), `<marquee> must be dropped by the allowlist (got: ${html})`);
        assert.ok(/scrolling text/.test(html), `inert text content is preserved (got: ${html})`);
    });

    it('drops resource-loading media elements the old denylist never blocked (<video>/<audio>)', () => {
        for (const tag of ['video', 'audio']) {
            const html = convertMarkdownToHtml(`Before\n\n<${tag} src="https://evil.example.com/x"></${tag}>\n\nAfter`);
            assert.ok(!new RegExp(`<${tag}[\\s>]`, 'i').test(html), `<${tag}> must be dropped by the allowlist (got: ${html})`);
            assert.ok(!/src\s*=/.test(html), `its resource-loading src must not survive (got: ${html})`);
        }
    });

    it('drops raw author-supplied inline <svg> and <math> at the allowlist root (documented normalization)', () => {
        const svgHtml = convertMarkdownToHtml('Before\n\n<svg width="10" height="10"><rect width="10" height="10"/></svg>\n\nAfter');
        assert.ok(!/<svg[\s>]/i.test(svgHtml), `raw <svg> must be dropped (got: ${svgHtml})`);
        assert.ok(!/<rect[\s>]/i.test(svgHtml), `svg children must be dropped with it (got: ${svgHtml})`);

        const mathHtml = convertMarkdownToHtml('Before\n\n<math><mn>1</mn></math>\n\nAfter');
        assert.ok(!/<math[\s>]/i.test(mathHtml), `raw <math> must be dropped (got: ${mathHtml})`);
        assert.ok(/Before/.test(svgHtml) && /After/.test(svgHtml), `surrounding content survives (got: ${svgHtml})`);
    });

    it('drops an unknown inert wrapper but lifts its allowlisted content', () => {
        const $ = cheerio.load(convertMarkdownToHtml('<article><p>kept paragraph</p></article>'));
        assert.strictEqual($('article').length, 0, 'unknown wrapper dropped');
        assert.strictEqual($('p').length, 1, 'allowlisted child lifted and preserved');
        assert.strictEqual($('p').text(), 'kept paragraph', 'child content preserved');
    });
});
