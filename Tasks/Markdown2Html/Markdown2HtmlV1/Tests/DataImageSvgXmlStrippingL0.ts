/**
 * data: URI scheme scenarios: a plain raster data:image/* URI is allowed, but
 * data:image/svg+xml is stripped everywhere -- an SVG document can embed
 * script/event-handler content that executes outside a plain <img> context,
 * unlike a raster format (see isDangerousUriScheme in uri-scheme-guard.ts).
 * Split from L0.ts into a self-titled scenario file (#565) matching the
 * sibling tasks' per-scenario Tests/ convention; mocha only runs Tests/L0.ts,
 * which imports this file.
 */

import assert = require('assert');
import { convertMarkdownToHtml } from '../src/render';

describe('data:image/svg+xml stripping (raster data: URIs allowed)', () => {
    it('allows a raster data:image/* URI (e.g. png) in an <img> src', () => {
        const html = convertMarkdownToHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
        assert.ok(/src\s*=/.test(html), `the raster data: URI must be preserved (got: ${html})`);
    });

    it('strips a data:image/svg+xml URI even on an <img> element (an SVG document can embed active content, unlike a raster format)', () => {
        const html = convertMarkdownToHtml('<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">');
        assert.ok(!/src\s*=/.test(html), `svg+xml data: URI must be stripped even on <img> (got: ${html})`);
    });

    it('strips a data:image/svg+xml URI on non-<img> elements (<a href>, <button formaction>)', () => {
        const anchorHtml = convertMarkdownToHtml('<a href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">x</a>');
        assert.ok(!/href\s*=/.test(anchorHtml), `<a href> must be stripped (got: ${anchorHtml})`);

        // Not wrapped in <form>: this specifically tests the formaction attribute
        // check (a standalone <button> is valid HTML), independent of the separate
        // wholesale <form>-element removal covered in DangerousTagsRemovalL0.ts.
        const formHtml = convertMarkdownToHtml('<button formaction="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">x</button>');
        assert.ok(!/formaction\s*=/.test(formHtml), `formaction must be stripped (got: ${formHtml})`);
    });
});
