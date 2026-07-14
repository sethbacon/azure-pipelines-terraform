/**
 * Markdown rendering utilities.
 * Ports preprocess_markdown, convert_markdown_to_html, post_process_html,
 * shift_heading_levels, _build_toc, _rewrite_md_links from md2html_converter.py.
 */

import path = require('path');
import MarkdownIt = require('markdown-it');
import * as cheerio from 'cheerio';
import hljs from 'highlight.js';
import { normalizeUriForSchemeCheck, isDangerousUriScheme, isDangerousMetaRefresh, URI_BEARING_ATTRIBUTES } from './uri-scheme-guard';

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
function escapeHtml(s: string): string {
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

const md = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
    highlight: (code, lang) => {
        const langClass = lang ? ` language-${lang}` : '';
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
 * Strip active-content vectors from rendered HTML while preserving benign
 * formatting markup (tables, <br>, <div>, code blocks, …). markdown-it runs
 * with html:true so author markdown can use raw formatting HTML — e.g. <br/>
 * inside a table cell, a common idiom — but that same passthrough would let a
 * raw <script>, an on*= event handler, or a javascript:/vbscript:/data: URI flow
 * into the ServiceNow KB body (a stored-XSS sink). This is the sanitizer allowlist
 * the markdown->HTML norm calls for; PublishKbArticle/html-validate.ts is the
 * downstream fail-closed gate and this is defense-in-depth at render time.
 */
export function sanitizeRenderedHtml(html: string): string {
    const $ = cheerio.load(html, { xmlMode: false });
    // Remove executable / embedding elements outright.
    $('script, iframe, object, embed, noscript').remove();
    // <base> can redirect every relative URL in the document; not needed in a
    // KB article fragment, so drop it outright rather than trying to validate it.
    $('base').remove();
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
    // Strip event-handler attributes and dangerous URIs from every element.
    $('*').each((_, el) => {
        const attribs = $(el).attr() ?? {};
        for (const name of Object.keys(attribs)) {
            const lname = name.toLowerCase();
            const value = normalizeUriForSchemeCheck(String(attribs[name]));
            if (lname.startsWith('on')) {
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
        tocItems.push(`${indent}<li><a href="#${hid}">${text}</a></li>`);
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
