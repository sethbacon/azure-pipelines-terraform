/**
 * Meta-refresh EXTERNAL-ORIGIN redirect scenarios (#889): a plain
 * `<meta http-equiv="refresh" content="0;url=https://evil.example/">` carries
 * no javascript:/vbscript: token, so the OLD isDangerousMetaRefresh (a bare
 * `.includes('javascript:')` check) let it straight through both the
 * fail-closed gate and the sanitizers -- the same silent off-site redirect
 * harm <base> is unconditionally rejected for, regardless of content.
 * isDangerousMetaRefresh (shared uri-scheme-guard.ts, byte-identical with
 * PublishKbArticle) now parses the `content` attribute per the WHATWG "shared
 * declarative refresh steps" and blocks only a target that carries its own
 * scheme or network-path authority -- a same-document fragment, an
 * empty/absent target (timed reload or self-refresh), or a scheme-less
 * relative path (same-origin, no more dangerous than the relative <a href>
 * links this pipeline already allows) all remain legitimate. Split into a
 * self-titled scenario file (#565) matching the sibling tasks' Tests/
 * convention; mocha only runs Tests/L0.ts, which imports this file.
 */

import assert = require('assert');
import { convertMarkdownToHtml } from '../src/render';
import { isDangerousMetaRefresh, normalizeUriForSchemeCheck } from '../src/uri-scheme-guard';

// Mirrors exactly what every real call site does: normalize, then predicate --
// isDangerousMetaRefresh itself assumes already-normalized input (see its doc
// comment), so calling it directly with raw/mixed-case values would test an
// input shape that never occurs in production.
function refreshIsDangerous(httpEquiv: string, content: string): boolean {
    return isDangerousMetaRefresh(normalizeUriForSchemeCheck(httpEquiv), normalizeUriForSchemeCheck(content));
}

describe('isDangerousMetaRefresh — external-origin redirect target (#889)', () => {
    const cases: Array<{ label: string; httpEquiv: string; content: string; expected: boolean }> = [
        // --- hostile: external origin / dangerous scheme --------------------
        { label: 'plain https external redirect (the reported #889 PoC)', httpEquiv: 'refresh', content: '0;url=https://evil.example/', expected: true },
        { label: 'external redirect with no "url=" token at all (raw-remainder fallback)', httpEquiv: 'refresh', content: '0;https://evil.example/', expected: true },
        { label: 'protocol-relative network-path target (//host)', httpEquiv: 'refresh', content: '0;url=//evil.example/path', expected: true },
        { label: 'backslash-trick network-path target (two leading backslashes)', httpEquiv: 'refresh', content: '0;url=\\\\evil.example/path', expected: true },
        { label: 'mixed slash/backslash network-path target (/\\ prefix)', httpEquiv: 'refresh', content: '0;url=/\\evil.example/path', expected: true },
        { label: 'javascript: scheme (pre-existing #446 case, still caught)', httpEquiv: 'refresh', content: '0;url=javascript:alert(1)', expected: true },
        { label: 'vbscript: scheme (pre-existing #446 case, still caught)', httpEquiv: 'refresh', content: '0;url=vbscript:msgbox(1)', expected: true },
        { label: 'padded, quoted and upper-cased URL= token', httpEquiv: 'REFRESH', content: "0; URL = 'https://evil.example/'", expected: true },
        { label: 'comma separator variant', httpEquiv: 'refresh', content: '0,url=https://evil.example/', expected: true },
        { label: 'whitespace between the time and the ";" separator', httpEquiv: 'refresh', content: '0 ;url=https://evil.example/', expected: true },
        { label: 'leading-dot time with no integer digits (".5"), still a valid refresh per spec', httpEquiv: 'refresh', content: '.5;url=https://evil.example/', expected: true },
        { label: 'data: URI target', httpEquiv: 'refresh', content: '0;url=data:text/html,<script>alert(1)</script>', expected: true },
        // --- legitimate: no external-origin navigation ----------------------
        { label: 'plain timed reload, no target at all', httpEquiv: 'refresh', content: '30', expected: false },
        { label: 'no leading digits and no "." either: not a valid refresh directive at all per spec (browser never navigates)', httpEquiv: 'refresh', content: 'url=https://evil.example/', expected: false },
        { label: 'same-document fragment refresh', httpEquiv: 'refresh', content: '5;url=#section2', expected: false },
        { label: 'empty url= target (self-refresh)', httpEquiv: 'refresh', content: '0;url=', expected: false },
        { label: 'separator with nothing after it (self-refresh)', httpEquiv: 'refresh', content: '0;', expected: false },
        { label: 'relative-path target ("this article has moved" pattern)', httpEquiv: 'refresh', content: '5;url=/kb/updated-article', expected: false },
        { label: "the HTML spec's own slideshow example (relative page4.html)", httpEquiv: 'refresh', content: '20; URL=page4.html', expected: false },
        { label: 'non-refresh http-equiv is never a meta-refresh regardless of content', httpEquiv: 'content-type', content: '0;url=https://evil.example/', expected: false },
    ];

    for (const c of cases) {
        it(`${c.expected ? 'flags' : 'allows'}: ${c.label}`, () => {
            assert.strictEqual(refreshIsDangerous(c.httpEquiv, c.content), c.expected, `content="${c.content}"`);
        });
    }
});

describe('Meta-refresh external-origin redirect stripped end-to-end (#889)', () => {
    it('removes a plain external-origin <meta refresh> with no javascript:/vbscript: token from rendered body content', () => {
        const html = convertMarkdownToHtml('<meta http-equiv="refresh" content="0;url=https://evil.example/">\n\nOk');
        assert.ok(!/<meta/i.test(html), `the external-redirect <meta refresh> must be removed (got: ${html})`);
    });
});
