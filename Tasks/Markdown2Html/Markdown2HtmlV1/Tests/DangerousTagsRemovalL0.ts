/**
 * DANGEROUS_TAGS removal scenarios: sanitizeRenderedHtml() (exercised through
 * convertMarkdownToHtml) must strip every member of the shared,
 * byte-identity-gated DANGEROUS_TAGS set (uri-scheme-guard.ts) --
 * iframe/object/embed/noscript, <form> (#446 follow-up), <link> (#523), the
 * SVG SMIL animation elements, and the MathML/foreign-content mXSS carriers
 * (#552). Split from L0.ts into a self-titled scenario file (#565) matching
 * the sibling tasks' per-scenario Tests/ convention; mocha only runs
 * Tests/L0.ts, which imports this file.
 */

import assert = require('assert');
import { convertMarkdownToHtml } from '../src/render';

describe('DANGEROUS_TAGS removal (shared allowlist, uri-scheme-guard.ts)', () => {
    it('removes <form> elements outright, closing the action="javascript:..." bypass (#446 follow-up)', () => {
        const html = convertMarkdownToHtml('Before\n\n<form action="javascript:alert(1)"><button>Submit</button></form>\n\nAfter');
        assert.ok(!/<form[\s>]/i.test(html), `<form> must be removed entirely (got: ${html})`);
        assert.ok(!/action\s*=/.test(html), `no action= attribute should survive (got: ${html})`);
    });

    it('removes iframe/object/embed/noscript via the shared DANGEROUS_TAGS filter (final-review regression check)', () => {
        // sanitizeRenderedHtml's removal mechanism for these elements was
        // refactored from a plain CSS selector to the shared DANGEROUS_TAGS
        // tagName-filter (so PublishKbArticle's gate could reuse the exact same
        // set) -- confirm the refactor didn't change render-time behavior.
        for (const tag of ['iframe', 'object', 'embed', 'noscript']) {
            const html = convertMarkdownToHtml(`Before\n\n<${tag}>x</${tag}>\n\nAfter`);
            assert.ok(!new RegExp(`<${tag}[\\s>]`, 'i').test(html), `<${tag}> must be removed (got: ${html})`);
        }
    });

    it('removes SVG SMIL animation elements that can dynamically assign a javascript: URI (#446 follow-up)', () => {
        const html = convertMarkdownToHtml(
            '<svg><a href="#safe"><animate attributeName="href" to="javascript:alert(1)"/>x</a></svg>',
        );
        assert.ok(!/<animate[\s/>]/i.test(html), `<animate> must be removed (got: ${html})`);
    });

    it('removes animateTransform, animateMotion, animateColor and set elements alongside animate', () => {
        for (const tag of ['animateTransform', 'animateMotion', 'animateColor', 'set']) {
            const html = convertMarkdownToHtml(`<svg><${tag} attributeName="href" to="javascript:alert(1)"/></svg>`);
            assert.ok(!new RegExp(`<${tag}[\\s/>]`, 'i').test(html), `<${tag}> must be removed (got: ${html})`);
        }
    });

    it('removes a <link rel="stylesheet"> via the shared DANGEROUS_TAGS filter (#523)', () => {
        const html = convertMarkdownToHtml('Before\n\n<link rel="stylesheet" href="https://evil.example.com/exfil.css">\n\nAfter');
        assert.ok(!/<link[\s>]/i.test(html), `<link> must be removed (got: ${html})`);
    });

    it('removes MathML mXSS carriers (<math>, <annotation-xml encoding="text/html">) wholesale (#552)', () => {
        const html = convertMarkdownToHtml(
            'Before\n\n<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>\n\nAfter',
        );
        assert.ok(!/<math[\s>]/i.test(html), `<math> must be removed (got: ${html})`);
        assert.ok(!/<annotation-xml[\s>]/i.test(html), `<annotation-xml> must be removed (got: ${html})`);
        assert.ok(!/<img[\s>]/i.test(html), `the payload embedded in the carrier must be removed with it (got: ${html})`);
        assert.ok(/Before/.test(html) && /After/.test(html), `surrounding content must survive (got: ${html})`);
    });

    it('removes <foreignObject> from preserved <svg> content and standalone mglyph/malignmark elements (#552)', () => {
        const svgHtml = convertMarkdownToHtml('<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>');
        assert.ok(!/<foreignObject[\s>]/i.test(svgHtml), `<foreignObject> must be removed (got: ${svgHtml})`);
        assert.ok(!/<img[\s>]/i.test(svgHtml), `the HTML-integration-point payload must be removed with it (got: ${svgHtml})`);
        for (const tag of ['mglyph', 'malignmark']) {
            const html = convertMarkdownToHtml(`Before\n\n<${tag}>x</${tag}>\n\nAfter`);
            assert.ok(!new RegExp(`<${tag}[\\s>]`, 'i').test(html), `<${tag}> must be removed (got: ${html})`);
        }
    });
});
