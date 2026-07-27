/**
 * Shared HTML allowlist sanitizer for the two consumers of the ServiceNow
 * KB-publishing pipeline: Markdown2Html's render-time `convertMarkdownToHtml()`
 * (sanitizes markdown-it's rendered output before generateHtmlDocument wraps it)
 * and PublishKbArticle's raw `htmlFile` publish path, via `sanitizeHtmlForPublish()`
 * in html-validate.ts (sanitizes operator-supplied HTML before it reaches the
 * ServiceNow `text` field -- a stored-XSS sink, #820). Kept byte-identical
 * across both tasks' `src/` directories and guarded by
 * scripts/check-shared-modules.js -- before #820, PublishKbArticle's htmlFile
 * input was only ever DENYLIST-validated (html-validate.ts's
 * validateHtmlContent) and then published VERBATIM, so a bypass of that
 * denylist (the same historical #446/#498/#523/#552/#587/#606 bypass lineage
 * uri-scheme-guard.ts documents) would have reached ServiceNow unfiltered; this
 * module is the belt-and-suspenders allowlist RE-SERIALIZATION layer that makes
 * the actually-published bytes only ever the enumerated allowlist, regardless
 * of what a denylist gate misses.
 *
 * sanitize-html (pure-Node, htmlparser2-based, allowlist-native) is used rather
 * than DOMPurify: this is a Node ADO task with no browser DOM, and DOMPurify
 * would drag in jsdom (a heavy full-DOM emulation) where sanitize-html needs
 * none. The allowlist inventory below was enumerated from what actually reaches
 * Markdown2Html's convertMarkdownToHtml (markdown-it's default-preset output --
 * paragraphs, ATX/setext headings, emphasis/strong/strikethrough, links, images,
 * inline+fenced code, blockquotes, ordered/bullet/definition lists, GFM tables
 * with per-column `style="text-align:…"` on th/td, thematic breaks, hard-break
 * <br>, and the highlight.js token spans inside fenced blocks -- see the
 * existing golden and #498 tests for the real class inventory), widened to the
 * common inert formatting tags a KB author might write as raw HTML (either via
 * markdown-it's html:true passthrough, or directly in a PublishKbArticle
 * htmlFile).
 *
 * Foreign-content namespaces (`<svg>`, `<math>`) are deliberately NOT allowlisted
 * -- they are the exact namespace-confusion / mXSS surface #552 flagged; dropping
 * them at the allowlist root closes that class rather than chasing individual
 * carriers. Raw author-supplied inline SVG/MathML is therefore not rendered (a
 * documented, security-motivated normalization). `class` passes through
 * unfiltered (all classes are inert and Markdown2Html's hljs theme relies on
 * them); `parseStyleAttributes` is off so a `style` value reaches
 * applyDefenseInDepthGuards verbatim -- its cssHasDangerousConstruct()
 * escape/comment-aware CSS check (#587), not sanitize-html's postcss
 * normalization, is the authority on dangerous CSS. `data:` is allowed only on
 * <img> (raster images) and narrowed further to non-SVG rasters by
 * isDangerousUriScheme() in the guard pass.
 *
 * transformTags forces rel="noopener noreferrer" onto any <a target=…> (#835):
 * an allowlisted target attribute without it lets a KB-article link's target
 * page run script that reassigns window.opener.location (reverse tabnabbing) --
 * the sanitizer keeps `target` (a legitimate KB-authoring need to open a link
 * in a new tab) but always adds the mitigating rel tokens, merging with --
 * rather than clobbering -- any rel value the author already set.
 */

import sanitizeHtml = require('sanitize-html');
import * as cheerio from 'cheerio';
import { normalizeUriForSchemeCheck, isDangerousUriScheme, isDangerousMetaRefresh, URI_BEARING_ATTRIBUTES, DANGEROUS_TAGS, cssHasDangerousConstruct } from './uri-scheme-guard';

/**
 * transformTags handler for `<a>` (#835): whenever a `target` attribute is
 * present (any value -- `_blank` is the motivating case, but a named target
 * can equally reference/create an auxiliary browsing context), force
 * rel="noopener noreferrer" onto the anchor. Merges with any rel tokens the
 * author already set (case-insensitively deduplicated, first-seen order kept)
 * rather than overwriting them. sanitize-html invokes transformTags BEFORE its
 * own allowedAttributes filtering, so the resulting `rel` still passes through
 * that filter normally -- `rel` is already allowlisted for `a` below.
 */
function forceNoopenerNoreferrer(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
    if (attribs.target === undefined) {
        return { tagName, attribs };
    }
    const tokens = (attribs.rel ?? '').split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    const relTokens = new Set(tokens);
    relTokens.add('noopener');
    relTokens.add('noreferrer');
    return { tagName, attribs: { ...attribs, rel: Array.from(relTokens).join(' ') } };
}

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
        // Inert on every element. `style` is allowlisted per-property below via
        // allowedStyles — sanitize-html PARSES the attribute and reconstructs it
        // from allowed property/value pairs only, so url()/escape/comment
        // smuggling dies structurally at this layer (#552); the guard pass's
        // CSS check remains only as a defense-in-depth pre-filter.
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
    // Parse `style` attributes and rebuild them from the property/value
    // allowlist below (#552). Anchored value patterns mean a url(), CSS escape,
    // comment-split, expression(), or -moz-binding form can never match — the
    // attribute is reconstructed from parsed declarations, never passed through
    // raw, so CSS safety no longer rests on the hand-rolled blocklist alone.
    // The inventory is exactly what the pipeline legitimately emits: GFM table
    // alignment (markdown-it renders `text-align`) and benign author color.
    parseStyleAttributes: true,
    allowedStyles: {
        '*': {
            'text-align': [/^(left|right|center|justify)$/],
            'color': [/^#[0-9a-fA-F]{3,8}$/, /^[a-zA-Z]+$/],
        },
    },
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
    // #835: force rel="noopener noreferrer" onto any <a target=…> — see
    // forceNoopenerNoreferrer above.
    transformTags: {
        a: forceNoopenerNoreferrer,
    },
};

/**
 * Strip active-content vectors from rendered HTML while preserving benign
 * formatting markup (tables, <br>, <div>, code blocks, …). Markdown2Html's
 * markdown-it runs with html:true so author markdown can use raw formatting
 * HTML — e.g. <br/> inside a table cell, a common idiom — but that same
 * passthrough would let a raw <script>, an on*= event handler, or a
 * javascript:/vbscript:/data: URI flow into the ServiceNow KB body (a
 * stored-XSS sink); PublishKbArticle's raw htmlFile input carries the same
 * risk directly.
 *
 * Two layers run here (#552): the primary defense is the vetted ALLOWLIST
 * sanitizer (sanitize-html, SANITIZE_HTML_OPTIONS) — it produces the final
 * bytes, so nothing outside the enumerated allowlist can survive. The
 * hand-rolled URI-scheme / CSS / event-handler guards (applyDefenseInDepthGuards)
 * run FIRST as a defense-in-depth pre-filter. Order matters: those guards parse
 * with cheerio/parse5, which implements the HTML5 foreign-content algorithm, so a
 * payload nested inside an mXSS carrier (e.g. `<img onerror>` inside
 * `<foreignObject>`/`<annotation-xml>`) is removed together with the carrier's
 * whole subtree. sanitize-html's htmlparser2 has no foreign-content parsing and
 * would instead LIFT that child out of the carrier, rescuing it; running the
 * parse5-based guards first removes the subtree intact, then the allowlist
 * narrows whatever remains.
 *
 * Callers must pass a BODY-ONLY fragment, never a full document: this pass ends
 * with `$('body').html()`, so a `<head>` given here would be silently discarded.
 * PublishKbArticle's sanitizeHtmlForPublish() (html-validate.ts) is the wrapper
 * that keeps a full document's own `<head>` intact and only routes its `<body>`
 * content through this function.
 */
export function sanitizeRenderedHtml(html: string): string {
    return applyAllowlistSanitizer(applyDefenseInDepthGuards(html));
}

/**
 * The final allowlist layer alone (no guard pre-filter). Exported so tests can
 * prove this layer is independently safe — i.e. that dangerous CSS/URI payloads
 * die here even if a future change weakened the pre-filter — and so callers
 * that already have a guard-cleaned (or otherwise trusted-shape) fragment can
 * apply just the allowlist. Production code processing untrusted HTML must
 * always go through sanitizeRenderedHtml.
 */
export function applyAllowlistSanitizer(html: string): string {
    return sanitizeHtml(html, SANITIZE_HTML_OPTIONS);
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
