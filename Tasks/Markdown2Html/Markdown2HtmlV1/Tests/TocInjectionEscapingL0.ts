/**
 * TOC/heading-id escaping scenarios (#12): buildToc() interpolates
 * cheerio-DECODED heading text and author-supplied raw `id` attributes into
 * HTML it builds AFTER sanitizeRenderedHtml has already run, so either value
 * left unescaped would reintroduce live markup past the sanitizer. Split from
 * L0.ts into a self-titled scenario file (#565) matching the sibling tasks'
 * per-scenario Tests/ convention; mocha only runs Tests/L0.ts, which imports
 * this file.
 */

import assert = require('assert');
import { buildToc } from '../src/render';

describe('TOC injection escaping (#12)', () => {
    it('escapes heading text in TOC entries, closing a decode-then-reinject XSS gap (#12)', () => {
        // A heading whose rendered HTML already has the tag ENCODED (e.g. because
        // it came from a markdown code span, which sanitizeRenderedHtml sees only
        // as inert escaped text) still decodes back to live markup via cheerio's
        // .text() -- buildToc must re-escape it before building the TOC <li>.
        const html = '<h1>&lt;img src=x onerror=alert(1)&gt;</h1><p>text</p>';
        const { toc } = buildToc(html);
        assert.ok(!/<img[\s>]/i.test(toc), `TOC must not contain a live <img> element (got: ${toc})`);
        assert.ok(toc.includes('&lt;img'), `TOC should contain the re-escaped heading text (got: ${toc})`);
    });

    it('escapes an author-supplied raw heading id, closing an href attribute-breakout (#12 follow-up)', () => {
        // markdown-it runs with html:true, so a heading can carry its own raw `id`
        // attribute straight from the source markdown/HTML. cheerio's .attr('id')
        // decodes it the same way .text() decodes heading content -- an id
        // containing a literal double-quote would otherwise break out of the
        // TOC's href="#..." attribute and inject live markup.
        const html = '<h1 id=\'a"><iframe srcdoc="x"></iframe><a href="b\'>Heading</h1>';
        const { toc } = buildToc(html);
        assert.ok(!/<iframe[\s>]/i.test(toc), `TOC must not contain a live <iframe> element (got: ${toc})`);
        assert.ok(toc.includes('&quot;'), `TOC should contain the re-escaped id value (got: ${toc})`);
    });
});
