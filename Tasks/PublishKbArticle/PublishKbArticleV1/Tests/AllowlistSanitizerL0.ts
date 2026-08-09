/**
 * Allowlist-sanitizer scenarios (#820) for PublishKbArticle's own consumption
 * of the shared html-sanitizer.ts module (byte-identical parity family with
 * Markdown2Html -- see scripts/check-shared-modules.js and
 * Tasks/Markdown2Html/Markdown2HtmlV1/Tests/AllowlistSanitizerL0.ts for the
 * sibling task's equivalent coverage of the same shared policy). This file
 * covers content fidelity and allowlist inversion for this task's own use of
 * applyAllowlistSanitizer, the #835 rel="noopener noreferrer" forcing on
 * <a target>, and PublishKbArticle-specific coverage of
 * sanitizeHtmlForPublish's full-document <body> extraction/splice behavior
 * (htmlFile is a full HTML document here, unlike Markdown2Html's body-only
 * fragment convention).
 *
 * Registered via Tests/L0.ts, which mocha actually runs.
 */

import assert = require('assert');
import * as cheerio from 'cheerio';
import { applyAllowlistSanitizer } from '../src/html-sanitizer';
import { sanitizeHtmlForPublish } from '../src/html-validate';

describe('Allowlist sanitizer — content fidelity (#820)', () => {
    it('preserves benign paragraph, link and image content', () => {
        const html = '<p>Hello <a href="https://example.com">world</a></p><img src="https://example.com/pic.png" alt="alt text">';
        const $ = cheerio.load(applyAllowlistSanitizer(html));
        assert.strictEqual($('p').length, 1, 'paragraph preserved');
        assert.strictEqual($('a').attr('href'), 'https://example.com', 'link href preserved');
        assert.strictEqual($('img').attr('src'), 'https://example.com/pic.png', 'image src preserved');
    });
});

describe('Allowlist sanitizer — inversion / normalization (#820)', () => {
    it('drops a non-dangerous but non-allowlisted element while keeping its inert text', () => {
        // <marquee> is not in the historical DANGEROUS_TAGS denylist, so
        // validateHtmlContent lets it through; the allowlist does not list it.
        const html = applyAllowlistSanitizer('Before<marquee>scrolling text</marquee>After');
        assert.ok(!/<marquee[\s>]/i.test(html), `<marquee> must be dropped by the allowlist (got: ${html})`);
        assert.ok(/scrolling text/.test(html), `inert text content is preserved (got: ${html})`);
    });
});

describe('Allowlist sanitizer — rel=noopener/noreferrer forcing (#835)', () => {
    it('forces rel="noopener noreferrer" onto an <a target="_blank"> with no existing rel', () => {
        const $ = cheerio.load(applyAllowlistSanitizer('<a href="https://example.com" target="_blank">link</a>'));
        const rel = ($('a').attr('rel') ?? '').split(/\s+/);
        assert.ok(rel.includes('noopener'), `noopener forced (got rel="${$('a').attr('rel')}")`);
        assert.ok(rel.includes('noreferrer'), `noreferrer forced (got rel="${$('a').attr('rel')}")`);
        assert.strictEqual($('a').attr('target'), '_blank', 'target preserved');
    });

    it('merges with an existing rel value rather than overwriting it', () => {
        const $ = cheerio.load(applyAllowlistSanitizer('<a href="https://example.com" target="_blank" rel="nofollow">link</a>'));
        const rel = ($('a').attr('rel') ?? '').split(/\s+/);
        assert.ok(rel.includes('nofollow'), `existing token kept (got rel="${$('a').attr('rel')}")`);
        assert.ok(rel.includes('noopener'), `noopener merged in (got rel="${$('a').attr('rel')}")`);
        assert.ok(rel.includes('noreferrer'), `noreferrer merged in (got rel="${$('a').attr('rel')}")`);
    });

    it('does not add a rel attribute to a link with no target', () => {
        const $ = cheerio.load(applyAllowlistSanitizer('<a href="https://example.com">link</a>'));
        assert.strictEqual($('a').attr('rel'), undefined, `no rel added without target (got: ${$('a').attr('rel')})`);
    });

    it('does not duplicate tokens when rel already contains noopener/noreferrer', () => {
        const $ = cheerio.load(applyAllowlistSanitizer('<a href="https://example.com" target="_blank" rel="noreferrer noopener">link</a>'));
        const rel = ($('a').attr('rel') ?? '').split(/\s+/);
        assert.strictEqual(rel.filter((t) => t === 'noopener').length, 1, `no duplicate noopener (got rel="${$('a').attr('rel')}")`);
        assert.strictEqual(rel.filter((t) => t === 'noreferrer').length, 1, `no duplicate noreferrer (got rel="${$('a').attr('rel')}")`);
    });
});

describe('sanitizeHtmlForPublish — real-parser head/body allowlist (#820)', () => {
    it('keeps a safe head (title, charset meta, url-free theme <style>) and allowlist-sanitizes the body', () => {
        const doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>My KB Article</title>'
            + '<style>.hljs{color:red}</style></head><body><p>Real content</p><marquee>drop me</marquee></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('head title').text(), 'My KB Article', 'head title preserved');
        assert.strictEqual($('head style').text(), '.hljs{color:red}', 'url-free theme style preserved');
        assert.strictEqual($('head meta[charset]').attr('charset'), 'utf-8', 'charset meta preserved');
        assert.strictEqual($('marquee').length, 0, 'non-allowlisted body element dropped');
        assert.ok(/Real content/.test($('body').text()), 'benign body content preserved');
    });

    it('drops active-content elements from the <head> (script/base/link) — no longer denylist-only (#820)', () => {
        const doc = '<!DOCTYPE html><html><head><title>t</title>'
            + '<script>alert(1)</script><base href="https://evil.example.com/">'
            + '<link rel="stylesheet" href="https://evil.example.com/x.css"></head>'
            + '<body><p>ok</p></body></html>';
        const out = sanitizeHtmlForPublish(doc);
        const $ = cheerio.load(out);
        assert.strictEqual($('head script').length, 0, `head <script> dropped (got: ${out})`);
        assert.strictEqual($('head base').length, 0, `head <base> dropped (got: ${out})`);
        assert.strictEqual($('head link').length, 0, `head <link> dropped (got: ${out})`);
        assert.strictEqual($('head title').text(), 't', 'safe head title kept');
    });

    it('drops a dangerous <meta http-equiv=refresh> and a url()-bearing <style> from the head, keeps the safe ones', () => {
        const doc = '<!DOCTYPE html><html><head>'
            + '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'
            + '<meta charset="utf-8">'
            + '<style>body{background:url(https://evil.example.com/x)}</style>'
            + '<style>.ok{color:blue}</style>'
            + '</head><body><p>ok</p></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('head meta[http-equiv]').length, 0, 'dangerous meta-refresh dropped');
        assert.strictEqual($('head meta[charset]').length, 1, 'safe charset meta kept');
        assert.strictEqual($('head style').length, 1, 'only the url-free style kept');
        assert.strictEqual($('head style').text(), '.ok{color:blue}', 'the safe style is the one kept');
    });

    it('drops a plain external-origin <meta refresh> from the head even without a javascript:/vbscript: token (#889)', () => {
        const doc = '<!DOCTYPE html><html><head><title>t</title>'
            + '<meta http-equiv="refresh" content="0;url=https://evil.example.com/">'
            + '</head><body><p>ok</p></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('head meta[http-equiv]').length, 0, 'external-origin meta-refresh dropped');
    });

    it('keeps a legitimate self/fragment/relative <meta refresh> in the head (#889)', () => {
        const doc = '<!DOCTYPE html><html><head><title>t</title>'
            + '<meta http-equiv="refresh" content="30">'
            + '<meta http-equiv="refresh" content="5;url=#section">'
            + '<meta http-equiv="refresh" content="5;url=/kb/updated-article">'
            + '</head><body><p>ok</p></body></html>';
        const out = sanitizeHtmlForPublish(doc);
        const $ = cheerio.load(out);
        assert.strictEqual($('head meta[http-equiv]').length, 3, `all 3 legitimate meta-refreshes kept (got: ${out})`);
    });

    it('strips active-content attributes (on*, dangerous style) from the <body> element itself while keeping benign ones', () => {
        const doc = '<html><head></head><body onload="alert(1)" style="background:url(https://evil.example.com/x)" class="kb-body"><p>ok</p></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('body').attr('onload'), undefined, 'body onload stripped');
        assert.strictEqual($('body').attr('style'), undefined, 'body dangerous style attribute stripped');
        assert.strictEqual($('body').attr('class'), 'kb-body', 'benign body attribute preserved');
    });

    it('is not fooled by a decoy <body>-shaped substring inside a <title> (parser-differential guard)', () => {
        // A byte-offset regex splitter would anchor on the decoy <body> in the
        // RCDATA title and mangle the document; a real parser treats it as inert
        // title text and still sanitizes the real body element.
        const doc = '<!DOCTYPE html><html><head><title>see <body onload=alert(1)> tag</title></head>'
            + '<body><p>real</p><marquee>drop me</marquee></body></html>';
        const out = sanitizeHtmlForPublish(doc);
        const $ = cheerio.load(out);
        assert.strictEqual($('marquee').length, 0, `real body still sanitized despite decoy title (got: ${out})`);
        assert.ok(/real/.test($('body').text()), 'real body content preserved');
    });

    it('reparents and sanitizes content that appears before <body> (HTML5 tree construction)', () => {
        // parse5 reparents a stray body-content element seen before <body> into the
        // body, so the allowlist covers it rather than it passing through unsanitized.
        const doc = '<!DOCTYPE html><html><head><title>t</title></head><marquee>drop me</marquee><body><p>ok</p></body></html>';
        const out = sanitizeHtmlForPublish(doc);
        assert.ok(!/<marquee[\s>]/i.test(out), `pre-body content is sanitized (got: ${out})`);
    });

    it('is not fooled by a decoy <body> inside an HTML comment (parser-differential guard)', () => {
        const doc = '<!DOCTYPE html><html><head><title>t</title></head>'
            + '<body><!-- <body onload=alert(1)> --><p>real</p><marquee>drop me</marquee></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('marquee').length, 0, 'real body sanitized despite comment-embedded decoy');
        assert.ok(/real/.test($('body').text()), 'real body content preserved');
    });

    it('is not fooled by a decoy </body> inside an attribute value (parser-differential guard)', () => {
        const doc = '<!DOCTYPE html><html><head><title>t</title></head>'
            + '<body><img src="https://example.com/x.png" alt="</body> not the end"><p>real</p><marquee>drop me</marquee></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('marquee').length, 0, 'real body sanitized despite attribute-embedded decoy');
        assert.ok(/real/.test($('body').text()), 'real body content preserved');
    });

    it('merges multiple <body> tags without leaving the second body\'s attrs/content unsanitized', () => {
        // parse5 merges a second <body> token's attributes into the single body
        // element and reparents its following content into that body.
        const doc = '<!DOCTYPE html><html><head><title>t</title></head>'
            + '<body><p>real</p></body><body onload="alert(1)"><marquee>drop me</marquee></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('body').attr('onload'), undefined, 'onload from the second <body> tag is stripped');
        assert.strictEqual($('marquee').length, 0, 'content from the second <body> is sanitized');
    });

    it('sanitizes content appearing after the last </body> (HTML5 reparents it into body)', () => {
        const doc = '<!DOCTYPE html><html><head><title>t</title></head><body><p>real</p></body>'
            + '<marquee>drop me</marquee></html>';
        const out = sanitizeHtmlForPublish(doc);
        assert.ok(!/<marquee[\s>]/i.test(out), `post-body content is sanitized (got: ${out})`);
    });

    it('sanitizes the whole string when given a bare fragment with no document wrapper', () => {
        const out = sanitizeHtmlForPublish('<p>Real content</p><marquee>drop me</marquee>');
        assert.ok(!/<marquee[\s>]/i.test(out), `fragment content is sanitized (got: ${out})`);
        assert.ok(/Real content/.test(out), 'benign content preserved');
    });

    it('preserves benign body attributes on a full document', () => {
        const doc = '<html><head></head><body class="kb-body"><p>content</p></body></html>';
        const $ = cheerio.load(sanitizeHtmlForPublish(doc));
        assert.strictEqual($('body').attr('class'), 'kb-body', 'body attributes preserved');
    });
});
