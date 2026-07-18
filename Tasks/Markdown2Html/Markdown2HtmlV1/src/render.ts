/**
 * Markdown rendering utilities.
 * Ports preprocess_markdown, convert_markdown_to_html, post_process_html,
 * shift_heading_levels, _build_toc, _rewrite_md_links from md2html_converter.py.
 */

import path = require('path');
import MarkdownIt = require('markdown-it');
import sanitizeHtml = require('sanitize-html');
import * as cheerio from 'cheerio';
import hljs from 'highlight.js';
import { normalizeUriForSchemeCheck, isDangerousUriScheme, isDangerousMetaRefresh, URI_BEARING_ATTRIBUTES, DANGEROUS_TAGS, cssHasDangerousConstruct } from './uri-scheme-guard';

// ---------------------------------------------------------------------------
// preprocessMarkdown
// ---------------------------------------------------------------------------

/**
 * Preprocess markdown text to fix common issues.
 * Ports preprocess_markdown — all 4 regex fixups applied verbatim.
 */
export function preprocessMarkdown(text: string): string {
    // 1. Blank line before numbered lists not preceded by blank line
    text = text.replace(/([^\n])\n(\d+[.)]) /g, '$1\n\n$2 ');

    // 2. Blank line before bullet lists not preceded by blank line
    text = text.replace(/([^\n])\n([-*+] )/g, '$1\n\n$2');

    // 3. Blank line before headers not preceded by blank line
    text = text.replace(/([^\n])\n(#{1,6} )/g, '$1\n\n$2');

    // 4a. Code fence inside list item — add blank line before the fence
    text = text.replace(/(\n\s+)(```[^\n]*\n)/g, '$1\n$2');

    // 4b. Closing code fence — add blank line after before next list item
    text = text.replace(/(\n)(```)\s*(\n\s+\d+[.)]) /g, '$1$2\n$3 ');

    return text;
}

// ---------------------------------------------------------------------------
// convertMarkdownToHtml
// ---------------------------------------------------------------------------

/**
 * Syntax-highlight a fenced code block via highlight.js, returning the inner
 * HTML for the <code> element. markdown-it wraps the return value in
 * <pre><code class="hljs ...">…</code></pre>. Falls back to escaped plain text
 * when the language is unknown or highlighting throws.
 */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function highlightCode(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
            // fall through to plain escaping
        }
    }
    // No/unknown language: escape so it renders as plain text, still inside .hljs.
    return escapeHtml(code);
}

/** Characters valid in a highlight.js language name/alias -- see the highlight callback below. */
const SAFE_LANG_TOKEN = /^[A-Za-z0-9_-]+$/;

const md = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
    highlight: (code, lang) => {
        // `lang` is the fenced-code-block info string -- untrusted document
        // content -- interpolated into a double-quoted class attribute.
        // sanitizeRenderedHtml re-parses and filters the rendered output
        // afterwards (defense-in-depth), but this sink should not rely solely
        // on that downstream pass (#498): allowlist to the characters valid in
        // a highlight.js language name/alias before interpolating, dropping
        // the class entirely otherwise. highlightCode still receives the raw
        // `lang` for the hljs.getLanguage() lookup -- an unmatched/hostile
        // token simply falls through to the plain-escaped-text path there,
        // same as any other unknown language.
        const safeLang = lang && SAFE_LANG_TOKEN.test(lang) ? lang : '';
        const langClass = safeLang ? ` language-${safeLang}` : '';
        return `<pre><code class="hljs${langClass}">${highlightCode(code, lang)}</code></pre>`;
    },
});

/**
 * Convert markdown text to HTML.
 * Uses markdown-it with html:true, linkify:false, typographer:false.
 * Tables are enabled by default in markdown-it.
 * Fenced code blocks are syntax-highlighted with highlight.js (hljs classes);
 * the matching theme CSS is embedded by generateHtmlDocument.
 * The rendered HTML is passed through sanitizeRenderedHtml so raw active-content
 * markup in the source markdown cannot reach the published KB article.
 */
export function convertMarkdownToHtml(text: string): string {
    const preprocessed = preprocessMarkdown(text);
    const html = md.render(preprocessed);
    return sanitizeRenderedHtml(postProcessHtml(html));
}

/**
 * The vetted allowlist for the primary sanitizer (sanitize-html). Inverting the
 * historically-bypassed hand-rolled DENYLIST to a maintained ALLOWLIST sanitizer
 * is the #552 remediation: six historical bypasses (#446/#498/#523/#552-mXSS/
 * #587/#606) proved a parse/serialize denylist over a stored-XSS sink leaks, so
 * only the tags/attributes this task's own renderer legitimately emits — plus
 * the inert formatting elements a KB author may hand-write via markdown-it's
 * html:true passthrough — are permitted; everything else is dropped fail-closed
 * by the allowlist, with no need to enumerate every future active-content vector.
 *
 * sanitize-html (pure-Node, htmlparser2-based, allowlist-native) is used rather
 * than DOMPurify: this is a Node ADO task with no browser DOM, and DOMPurify
 * would drag in jsdom (a heavy full-DOM emulation) where sanitize-html needs
 * none. The allowlist inventory below was enumerated from what actually reaches
 * this function: markdown-it's default-preset output (paragraphs, ATX/setext
 * headings, emphasis/strong/strikethrough, links, images, inline+fenced code,
 * blockquotes, ordered/bullet/definition lists, GFM tables with per-column
 * `style="text-align:…"` on th/td, thematic breaks, hard-break <br>) and the
 * highlight.js token spans inside fenced blocks (`<pre><code class="hljs
 * language-…">` wrapping `<span class="hljs-…">` — see the existing golden and
 * #498 tests for the real class inventory), widened to the common inert
 * formatting tags a KB author might write as raw HTML.
 *
 * Foreign-content namespaces (`<svg>`, `<math>`) are deliberately NOT allowlisted
 * — markdown-it never emits them, and they are the exact namespace-confusion /
 * mXSS surface #552 flagged; dropping them at the allowlist root closes that
 * class rather than chasing individual carriers. Raw author-supplied inline SVG/
 * MathML is therefore no longer rendered (a documented, security-motivated
 * normalization); ordinary markdown is unaffected. `class` passes through
 * unfiltered (all classes are inert and the hljs theme relies on them);
 * `parseStyleAttributes` is off so a `style` value reaches applyDefenseInDepthGuards
 * verbatim — its cssHasDangerousConstruct() escape/comment-aware CSS check (#587),
 * not sanitize-html's postcss normalization, is the authority on dangerous CSS.
 * `data:` is allowed only on <img> (raster images) and narrowed further to
 * non-SVG rasters by isDangerousUriScheme() in the guard pass.
 */
const SANITIZE_HTML_OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: [
        // markdown-it structural + block output
        'p', 'br', 'hr', 'blockquote', 'pre', 'code',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
        'a', 'img',
        // markdown-it inline output + inert author-written formatting
        'em', 'strong', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
        'b', 'i', 'u', 'strike', 'span', 'div', 'wbr',
        'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time',
        'figure', 'figcaption',
    ],
    allowedAttributes: {
        // Inert on every element; `style` is retained for GFM table alignment and
        // benign author styles, then re-checked by the guard pass (dangerous CSS
        // constructs are stripped there, not here).
        '*': ['class', 'id', 'title', 'style', 'align', 'dir', 'lang'],
        a: ['href', 'name', 'target', 'rel'],
        img: ['src', 'alt', 'width', 'height'],
        ol: ['start', 'type', 'reversed'],
        li: ['value'],
        td: ['colspan', 'rowspan', 'headers', 'scope'],
        th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
        col: ['span'],
        colgroup: ['span'],
        q: ['cite'],
        blockquote: ['cite'],
        time: ['datetime'],
    },
    // Relative and fragment URLs are allowed by default (no scheme); `data:` is
    // permitted only on <img> so a raster image survives — isDangerousUriScheme()
    // in the guard pass then rejects data:image/svg+xml specifically.
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'ftp'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    // Drop disallowed tags but keep their (already guard-cleaned) benign children,
    // so an unknown wrapper an author wrote loses only the wrapper, not its text.
    disallowedTagsMode: 'discard',
    // Pass a `style` attribute through verbatim; the guard pass owns CSS safety.
    parseStyleAttributes: false,
    // Backstop: drop these elements AND their entire subtree (not just the tag).
    // Setting nonTextTags REPLACES sanitize-html's defaults, so its four defaults
    // (script/style/textarea/option) are re-listed here, then extended with the
    // shared DANGEROUS_TAGS set (which already includes script/noscript and the
    // SVG/MathML mXSS carriers). The guard pass already removes DANGEROUS_TAGS via
    // parse5's foreign-content-aware parsing before this runs; listing them here
    // too means a top-level carrier the guard somehow missed still cannot lift a
    // child out of the allowlist. `class`/`style` are intentionally absent from
    // allowedClasses/allowedStyles filtering so all classes and (guard-approved)
    // styles survive.
    nonTextTags: ['script', 'style', 'textarea', 'option', ...DANGEROUS_TAGS],
};

/**
 * Strip active-content vectors from rendered HTML while preserving benign
 * formatting markup (tables, <br>, <div>, code blocks, …). markdown-it runs
 * with html:true so author markdown can use raw formatting HTML — e.g. <br/>
 * inside a table cell, a common idiom — but that same passthrough would let a
 * raw <script>, an on*= event handler, or a javascript:/vbscript:/data: URI flow
 * into the ServiceNow KB body (a stored-XSS sink).
 *
 * Two layers run here (#552): the primary defense is now the vetted ALLOWLIST
 * sanitizer (sanitize-html, SANITIZE_HTML_OPTIONS) — it produces the final bytes,
 * so nothing outside the enumerated allowlist can survive. The retained
 * hand-rolled URI-scheme / CSS / event-handler guards (applyDefenseInDepthGuards)
 * run FIRST as a defense-in-depth pre-filter. Order matters: those guards parse
 * with cheerio/parse5, which implements the HTML5 foreign-content algorithm, so a
 * payload nested inside an mXSS carrier (e.g. `<img onerror>` inside
 * `<foreignObject>`/`<annotation-xml>`) is removed together with the carrier's
 * whole subtree. sanitize-html's htmlparser2 has no foreign-content parsing and
 * would instead LIFT that child out of the carrier, rescuing it; running the
 * parse5-based guards first removes the subtree intact, then the allowlist
 * narrows whatever remains. PublishKbArticle/html-validate.ts stays the
 * independent downstream fail-closed gate on raw author HTML.
 */
export function sanitizeRenderedHtml(html: string): string {
    return sanitizeHtml(applyDefenseInDepthGuards(html), SANITIZE_HTML_OPTIONS);
}

/**
 * Defense-in-depth pre-filter: the original hand-rolled guards, retained beneath
 * the allowlist sanitizer. Uses cheerio/parse5 (foreign-content-aware) so an
 * mXSS carrier's whole subtree is removed intact before the allowlist pass — see
 * sanitizeRenderedHtml for why this must precede sanitize-html.
 */
function applyDefenseInDepthGuards(html: string): string {
    const $ = cheerio.load(html, { xmlMode: false });
    // Remove executable / embedding elements (script/iframe/object/embed/
    // noscript) outright. <form> has no legitimate use in a KB article
    // fragment, and an action="javascript:..." attribute is otherwise a
    // blocklist-fragile per-attribute check (#446 follow-up). <link> (#523)
    // is a CSS-injection/exfiltration vector with no legitimate use here
    // either. SVG SMIL animation elements (animate/animateColor/
    // animateTransform/animateMotion/set) can dynamically assign a
    // javascript: URI into a referenced attribute (e.g. an <a>'s href) at
    // runtime via their to/from/values attributes, a vector a static
    // attribute-value scan cannot catch -- drop them outright too.
    // DANGEROUS_TAGS is the shared, byte-identity-gated set
    // (uri-scheme-guard.ts) also used by PublishKbArticle's
    // validateHtmlContent gate -- keeping this single set shared (rather than
    // a separately-hand-typed CSS selector here) is what keeps the two layers
    // from drifting on which elements are dangerous.
    $('*').filter((_, el) => DANGEROUS_TAGS.has(($(el).prop('tagName') ?? '').toLowerCase())).remove();
    // <base> can redirect every relative URL in the document; not needed in a
    // KB article fragment, so drop it outright rather than trying to validate it.
    $('base').remove();
    // <style> has no legitimate use in author-supplied markdown/HTML source --
    // this function only ever sees body-only content, before generateHtmlDocument
    // wraps it in the document's own trusted <head><style> block, so any <style>
    // reaching here came from the markdown source and is a CSS-injection vector
    // (exfiltration via attribute-selector background: url(...), clickjacking via
    // position: fixed). Deliberately handled here rather than via the shared
    // DANGEROUS_TAGS set -- see uri-scheme-guard.ts for why (#523).
    $('style').remove();
    // <meta http-equiv="refresh" content="0;url=javascript:..."> is a redirect-based
    // active-content vector the href/src attribute check below never sees (it's in
    // a `content` attribute, not `href`/`src`).
    $('meta').each((_, el) => {
        const httpEquiv = normalizeUriForSchemeCheck(String($(el).attr('http-equiv') ?? ''));
        const content = normalizeUriForSchemeCheck(String($(el).attr('content') ?? ''));
        if (isDangerousMetaRefresh(httpEquiv, content)) {
            $(el).remove();
        }
    });
    // Strip event-handler attributes, dangerous URIs, and an inline `style=`
    // attribute carrying a network-fetching CSS construct from every element.
    // The <style> ELEMENT is dropped wholesale above, but an inline `style`
    // ATTRIBUTE (e.g. <div style="background:url(...)">) is the simplest carrier
    // of the same #523 CSS-exfiltration primitive and was previously left
    // intact -- match it with the same shared cssHasDangerousConstruct() (which
    // runs DANGEROUS_CSS_PATTERN on the comment-stripped raw value AND its
    // escape-decoded form) for parity with PublishKbArticle's gate and to close
    // the browser-tokenizer bypass a raw-text match misses (#587).
    $('*').each((_, el) => {
        const attribs = $(el).attr() ?? {};
        for (const name of Object.keys(attribs)) {
            const lname = name.toLowerCase();
            const value = normalizeUriForSchemeCheck(String(attribs[name]));
            if (lname.startsWith('on')) {
                $(el).removeAttr(name);
            } else if (lname === 'style' && cssHasDangerousConstruct(String(attribs[name]))) {
                $(el).removeAttr(name);
            } else if (
                URI_BEARING_ATTRIBUTES.has(lname) &&
                isDangerousUriScheme(value)
            ) {
                $(el).removeAttr(name);
            }
        }
    });
    return $('body').html() ?? '';
}

// ---------------------------------------------------------------------------
// postProcessHtml
// ---------------------------------------------------------------------------

/**
 * Post-process HTML to fix orphan <li> items that contain numbered markers.
 * Ports post_process_html — wraps matching <li> groups in <ol>.
 */
export function postProcessHtml(html: string): string {
    // Only apply if no <ol> already present
    const pattern = /(<li>\d+[.)].+?<\/li>\s*)+/g;
    if (!html.includes('<ol>') && pattern.test(html)) {
        return html.replace(pattern, (match) => `<ol>\n${match}</ol>`);
    }
    return html;
}

// ---------------------------------------------------------------------------
// shiftHeadingLevels
// ---------------------------------------------------------------------------

/**
 * Demote all heading levels in HTML by shift (e.g. shift=1: h1→h2, h2→h3).
 * Ports shift_heading_levels — caps at h6, preserves attributes.
 */
export function shiftHeadingLevels(html: string, shift: number): string {
    if (!shift) return html;

    html = html.replace(/<h([1-6])(\s[^>]*|)>/gi, (_m, level, attrs) => {
        const newLevel = Math.min(parseInt(level, 10) + shift, 6);
        return `<h${newLevel}${attrs}>`;
    });

    html = html.replace(/<\/h([1-6])>/gi, (_m, level) => {
        const newLevel = Math.min(parseInt(level, 10) + shift, 6);
        return `</h${newLevel}>`;
    });

    return html;
}

// ---------------------------------------------------------------------------
// buildToc
// ---------------------------------------------------------------------------

export interface TocResult {
    toc: string;
    html: string;
}

/**
 * Generate a <nav class="kb-toc"> block from H1–H3 headings.
 * Injects id attributes into headings (matches _build_toc + path_to_section_id slug algorithm).
 * Returns { toc, html } where html has ids injected.
 */
export function buildToc(html: string): TocResult {
    const $ = cheerio.load(html, { xmlMode: false });
    const headings = $('h1, h2, h3').toArray();

    if (headings.length === 0) {
        return { toc: '', html };
    }

    const tocItems: string[] = [];

    for (const el of headings) {
        const $el = $(el);
        const text = $el.text();
        let hid = $el.attr('id');
        if (!hid) {
            // slug algorithm from _build_toc: replace non-word chars with '-', collapse, strip
            hid = text.toLowerCase().replace(/[^\w-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            $el.attr('id', hid);
        }
        const tagName = $el.prop('tagName') ?? '';
        const level = parseInt(tagName.slice(1), 10);
        const indent = '  '.repeat(level - 1);
        // hid is EITHER a computed slug ([\w-]+ only, attribute-safe) OR an
        // author-supplied raw `id` attribute from the source HTML (markdown-it
        // runs with html:true, so a heading like `<h2 id='a"><iframe ...'>` is
        // possible) -- cheerio's .attr('id') decodes it just like .text() decodes
        // heading content, so it is NOT safe to assume attribute-clean. Escaping
        // it here closes an href="#..." attribute-breakout that a raw id would
        // otherwise reopen; text is the raw heading content and separately MUST be
        // escaped for the same reason -- this TOC block is built from html that
        // has ALREADY been through sanitizeRenderedHtml, so either unescaped value
        // would reintroduce live markup after the sanitizer already ran (#12).
        tocItems.push(`${indent}<li><a href="#${escapeHtml(hid)}">${escapeHtml(text)}</a></li>`);
    }

    const toc =
        '<nav class="kb-toc">\n<h2>Table of Contents</h2>\n<ul>\n' +
        tocItems.join('\n') +
        '\n</ul>\n</nav>\n';

    // Return only the body HTML (not the full <html>/<body> wrapper cheerio adds)
    const modifiedHtml = $('body').html() ?? html;

    return { toc, html: modifiedHtml };
}

// ---------------------------------------------------------------------------
// rewriteMdLinks
// ---------------------------------------------------------------------------

/**
 * Rewrite [text](path.md) links to [text](#anchor) for files tracked in sectionIds.
 * Ports _rewrite_md_links — only rewrites local .md links present in sectionIds.
 */
export function rewriteMdLinks(
    mdContent: string,
    filePath: string,
    sectionIds: Map<string, string>,
    sectionAnchors: boolean
): string {
    if (!sectionAnchors || sectionIds.size === 0) {
        return mdContent;
    }

    const fileDir = path.dirname(path.resolve(filePath));

    return mdContent.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, linkTarget) => {
        if (/^(https?:|#|mailto:)/.test(linkTarget)) {
            return _match;
        }
        if (!linkTarget.toLowerCase().endsWith('.md')) {
            return _match;
        }
        const absTarget = path.resolve(path.join(fileDir, linkTarget));
        const sectionId = sectionIds.get(absTarget);
        if (sectionId) {
            return `[${linkText}](#${sectionId})`;
        }
        return _match;
    });
}

// ---------------------------------------------------------------------------
// pathToSectionId
// ---------------------------------------------------------------------------

/**
 * Convert a file path to a stable section anchor id slug.
 * Ports path_to_section_id.
 */
export function pathToSectionId(primaryDir: string, filePath: string): string {
    const rel = path.relative(primaryDir, filePath);
    let slug = rel.replace(/[/\\.]/g, '-').toLowerCase();
    slug = slug.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return slug;
}
