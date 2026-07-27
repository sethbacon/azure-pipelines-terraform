import * as fs from 'fs';
import { load } from 'cheerio';
import { normalizeUriForSchemeCheck, isDangerousUriScheme, isDangerousMetaRefresh, URI_BEARING_ATTRIBUTES, DANGEROUS_TAGS, cssHasDangerousConstruct } from './uri-scheme-guard';
import { sanitizeRenderedHtml } from './html-sanitizer';
import tasks = require('azure-pipelines-task-lib/task');

/**
 * Upper bound on the operator-supplied `htmlFile` read into memory (#677).
 * Matches the 10MB cap this codebase applies to comparable local-file/HTTP-
 * response reads elsewhere (CWE-400).
 */
export const MAX_HTML_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Validate HTML content for common issues.
 *
 * `force` ONLY downgrades the content-loss heuristic below (a false-positive-
 * prone parsing-fidelity check, not a security control) from a throw to a
 * warning. Every other check here is a stored-XSS/active-content defense
 * (external/inline `<script>`, inline event handlers, `<base>`/meta-refresh
 * redirects, javascript:/vbscript:/non-image data: URIs) and always throws
 * regardless of `force` -- these are deterministic invariants with no
 * legitimate false-positive case, unlike the content-loss heuristic, so
 * letting `force` bypass them would let a KB author (or a compromised
 * upstream markdown source) simply opt out of XSS protection entirely.
 */
export function validateHtmlContent(html: string, force: boolean = false): void {
    const $ = load(html);
    const parsedHtml = $.html();

    // Content-loss heuristic: parsed output should be at least 50% the length of input
    if (parsedHtml.length < html.length * 0.5) {
        const msg = tasks.loc('HtmlContentLoss');
        if (!force) {
            throw new Error(msg);
        }
        console.warn(`[WARN] HTML validation: ${msg}`);
    }

    // Reject external scripts (security: no remote script injection in KB articles)
    let externalScriptFound = false;
    $('script').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.startsWith('http://') || src.startsWith('https://')) {
            externalScriptFound = true;
        }
    });

    if (externalScriptFound) {
        throw new Error(tasks.loc('ExternalScriptNotAllowed'));
    }

    // Reject inline <script> elements: even without a remote src, inline script
    // executes in the browser of anyone viewing the published KB article.
    let inlineScriptFound = false;
    $('script').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (!(src.startsWith('http://') || src.startsWith('https://'))) {
            inlineScriptFound = true;
        }
    });

    if (inlineScriptFound) {
        throw new Error(tasks.loc('InlineScriptNotAllowed'));
    }

    // Reject <base> (redirects every relative URL in the document) and a
    // <meta http-equiv="refresh"> that redirects to a javascript:/vbscript: URI
    // — active-content vectors the href/src attribute check below never sees.
    let baseOrMetaRefreshFound = false;
    $('base').each(() => { baseOrMetaRefreshFound = true; });
    $('meta').each((_, el) => {
        const httpEquiv = normalizeUriForSchemeCheck(String($(el).attr('http-equiv') ?? ''));
        const content = normalizeUriForSchemeCheck(String($(el).attr('content') ?? ''));
        if (isDangerousMetaRefresh(httpEquiv, content)) {
            baseOrMetaRefreshFound = true;
        }
    });
    if (baseOrMetaRefreshFound) {
        throw new Error(tasks.loc('BaseOrMetaRefreshNotAllowed'));
    }

    // Reject executable/embedding elements (<iframe>/<object>/<embed>/
    // <noscript> -- the <script> checks above already cover <script>),
    // <form> (no legitimate use in a KB article; an action="javascript:..."
    // attribute is otherwise a blocklist-fragile per-element check), <link>
    // (#523: a CSS-injection/exfiltration vector with no legitimate use in
    // this task's input either), and SVG SMIL animation elements
    // (animate/animateColor/animateTransform/animateMotion/set), which can
    // dynamically assign a javascript: URI into a referenced attribute (e.g.
    // an <a>'s href) via their to/from/values attributes at runtime — a
    // vector the static attribute-value scan below never sees (#446
    // follow-up). Before iframe/object/embed/noscript were added here, this
    // fail-closed gate never rejected them at all -- only Markdown2Html's
    // render-time sanitizer stripped them -- so HTML supplied directly via
    // the htmlFile input (bypassing Markdown2Html entirely) could carry a
    // live <iframe srcdoc="..."> past the gate. DANGEROUS_TAGS is the
    // shared, byte-identity-gated set (uri-scheme-guard.ts) also used by
    // Markdown2Html's render-time sanitizeRenderedHtml.
    let dangerousTagFound = false;
    $('*').each((_, el) => {
        if (DANGEROUS_TAGS.has(($(el).prop('tagName') ?? '').toLowerCase())) {
            dangerousTagFound = true;
        }
    });
    if (dangerousTagFound) {
        throw new Error(tasks.loc('FormOrSvgAnimationNotAllowed'));
    }

    // Reject <style> content containing a network-fetching CSS construct
    // (#523). Markdown2Html's generateHtmlDocument() legitimately injects its
    // own <head><style>...</style></head> into every document it produces --
    // ServiceNow is verified to preserve and render it (see
    // Markdown2Html/src/highlight-theme.ts) -- and the documented
    // Markdown2Html -> PublishKbArticle pipeline feeds that whole generated
    // document into this task's htmlFile input verbatim, so an outright,
    // document-wide reject of every <style> (the pattern used for the
    // DANGEROUS_TAGS members above) would fail this gate on every legitimate
    // run. A structural "reject <style> outside <head>" check was considered
    // instead but rejected: an attacker supplying a raw htmlFile that bypasses
    // Markdown2Html entirely can trivially wrap a hostile <style> in its own
    // `<head>...</head>` (implicit or explicit -- cheerio/parse5 places a
    // `<style>` seen before any body content into <head> regardless), which
    // would make a head/body-scoped check no real defense against a deliberate
    // attacker. Checking the CSS content itself for the actual exfiltration
    // primitive -- any `url(...)` reference (background-image, @import,
    // @font-face src, list-style-image, cursor, etc. all ultimately require
    // one to fetch anything) -- closes that gap regardless of where the
    // <style> element sits, and Markdown2Html's own generated CSS is a fixed,
    // hardcoded string with no `url(...)`/`@import` (verified), so this never
    // rejects the legitimate document wrapper. The <style> ELEMENT is
    // deliberately not part of the shared DANGEROUS_TAGS set (element-presence-
    // based, not content-based) -- see uri-scheme-guard.ts for why. The CSS
    // construct pattern itself is DANGEROUS_CSS_PATTERN, shared from that same
    // byte-identity-gated module (the inline `style` attribute check below uses
    // it too). cssHasDangerousConstruct() runs that pattern the way a browser
    // lexes CSS — comments stripped first, then the same text escape-decoded —
    // so a browser-decoded escape (`\75rl(...)`, `@\69mport`) or a comment-split
    // (`url` `(` separated by a CSS comment) can't slip a fetch past this
    // raw-text pattern (#587).
    let dangerousStyleContentFound = false;
    $('style').each((_, el) => {
        if (cssHasDangerousConstruct($(el).text())) {
            dangerousStyleContentFound = true;
        }
    });
    if (dangerousStyleContentFound) {
        throw new Error(tasks.loc('DangerousStyleContentNotAllowed'));
    }

    // Reject inline event-handler attributes (onerror=, onload=, onclick=, …),
    // javascript:/vbscript:/non-image data: URIs, and an inline `style=`
    // attribute carrying a network-fetching CSS construct — all stored-XSS /
    // CSS-exfiltration vectors the external <script src> check above does not
    // cover. The inline `style` attribute is the simplest delivery mechanism
    // for the exact #523 exfiltration primitive (background: url(...)) and,
    // unlike the <style>-element check above, was previously unguarded here --
    // it is checked with the same shared cssHasDangerousConstruct() (which runs
    // DANGEROUS_CSS_PATTERN on the comment-stripped raw value AND its escape-
    // decoded form) for parity with that element-content check and to close the
    // same browser-tokenizer bypass (#587).
    let eventHandlerFound = false;
    let dangerousUriFound = false;
    let dangerousStyleAttrFound = false;
    $('*').each((_, el) => {
        const attribs = $(el).attr() ?? {};
        for (const name of Object.keys(attribs)) {
            const lname = name.toLowerCase();
            const value = normalizeUriForSchemeCheck(String(attribs[name]));
            if (lname.startsWith('on')) {
                eventHandlerFound = true;
            } else if (lname === 'style' && cssHasDangerousConstruct(String(attribs[name]))) {
                dangerousStyleAttrFound = true;
            } else if (
                URI_BEARING_ATTRIBUTES.has(lname) &&
                isDangerousUriScheme(value)
            ) {
                dangerousUriFound = true;
            }
        }
    });

    if (eventHandlerFound) {
        throw new Error(tasks.loc('EventHandlerNotAllowed'));
    }

    if (dangerousStyleAttrFound) {
        throw new Error(tasks.loc('DangerousStyleAttributeNotAllowed'));
    }

    if (dangerousUriFound) {
        throw new Error(tasks.loc('DangerousUriNotAllowed'));
    }
}

/**
 * Read an HTML file from disk. Throws if the file does not exist or exceeds
 * MAX_HTML_FILE_BYTES (#677) -- the size is checked before the read so an
 * oversized file is never buffered into memory at all. Opens the file ONE
 * time and stats/reads that same file descriptor (fstat + read, not
 * statSync/existsSync + readFileSync on the path) so there is no window
 * between the size check and the read where the path could be repointed at a
 * different, larger file (TOCTOU / CWE-367, flagged by CodeQL on the earlier
 * existsSync+statSync-then-readFileSync version).
 */
export function readHtmlFile(filePath: string): string {
    let fd: number;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(tasks.loc('HtmlFileNotFound', filePath));
        }
        throw err;
    }
    try {
        const size = fs.fstatSync(fd).size;
        if (size > MAX_HTML_FILE_BYTES) {
            throw new Error(tasks.loc('HtmlFileTooLarge', filePath, size, MAX_HTML_FILE_BYTES));
        }
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, 0);
        return buffer.toString('utf-8');
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Route the operator-supplied `htmlFile` through the shared allowlist sanitizer
 * (html-sanitizer.ts) before it reaches ServiceNow's `text` field -- a
 * stored-XSS sink (#820). Previously this content was only ever DENYLIST-
 * validated (validateHtmlContent above) and then published VERBATIM, so a
 * bypass of that denylist (the #446/#498/#523/#552/#587/#606 bypass lineage
 * uri-scheme-guard.ts documents) would have reached ServiceNow unfiltered.
 * validateHtmlContent() is still called first and is UNCHANGED -- it remains
 * a useful fail-closed pre-check (a clear "your <script> was rejected" error
 * is better authoring UX than silently stripping it) -- this function is the
 * belt-and-suspenders re-serialization layer that makes the actually-published
 * bytes only ever the enumerated allowlist, regardless of what the denylist
 * gate misses.
 *
 * `htmlFile` is arbitrary operator-supplied content (task.json: "Path to an HTML
 * file whose contents become the article body") -- it may be a full
 * `<!DOCTYPE html>...<body>...</body></html>` document (the documented
 * Markdown2Html -> PublishKbArticle pipeline feeds one in verbatim) OR a bare
 * fragment, and NONE of it is trusted: the whole file is author-controlled and
 * every byte can reach the broader KB-reader audience. The head/body split is
 * therefore done with a REAL parser (cheerio/parse5 -- the SAME parser
 * validateHtmlContent uses one function above), never a byte-offset regex: a
 * regex over `<body>`/`</body>` can be fooled by a `<body>`-shaped substring
 * inside a comment, an attribute value, or an RCDATA element (<title>/
 * <textarea>) into anchoring on the wrong span, which both silently mangles
 * legitimate content AND reintroduces the exact parser-differential class #820
 * exists to eliminate. parse5 also applies the HTML5 tree-construction
 * algorithm, so any pre-/post-body content a browser would reparent is
 * normalized into <head>/<body> here identically -- there is no third,
 * unsanitized region.
 *
 * Both regions are sanitized to allowlist strength: the <body> inner HTML goes
 * through the shared sanitizeRenderedHtml() (guard pre-filter + sanitize-html
 * allowlist), and the <head> is allowlisted in place to exactly {<title>, safe
 * <meta>, safe <style>} -- preserving the legitimate, fixed, url-free
 * Markdown2Html hljs-theme <style> (ServiceNow renders it) while dropping
 * <script>/<base>/<link>/any unknown element, so the head no longer rests on
 * the denylist alone.
 */
const HEAD_ALLOWED_TAGS = new Set(['title', 'meta', 'style']);

export function sanitizeHtmlForPublish(html: string): string {
    // Split head/body with the SAME real parser (cheerio/parse5) that
    // validateHtmlContent uses -- never a byte-offset regex (see the doc comment).
    const $ = load(html);
    const sanitizedBody = sanitizeRenderedHtml($('body').html() ?? '');

    // Fragment vs. full-document selects OUTPUT SHAPE only (a fragment keeps its
    // historical body-fragment form); the security boundary is always the
    // real-parser split above, so this decision can never leave content
    // unsanitized -- the body was already fully sanitized regardless.
    if (!/<(?:!doctype|html|head|body)[\s/>]/i.test(html)) {
        return sanitizedBody;
    }

    $('body').html(sanitizedBody);

    // Allowlist the <head> to {title, safe meta, safe style}: drop every other
    // element (<script>/<base>/<link>/unknown), a dangerous <meta http-equiv=
    // refresh>, and a <style> whose CSS carries a network-fetching/active
    // construct -- the fixed, url-free Markdown2Html hljs theme passes and is
    // preserved -- giving the head body-equal allowlist strength (#820).
    $('head').children().each((_, el) => {
        const tag = ($(el).prop('tagName') ?? '').toLowerCase();
        if (!HEAD_ALLOWED_TAGS.has(tag)) { $(el).remove(); return; }
        if (tag === 'meta') {
            const httpEquiv = normalizeUriForSchemeCheck(String($(el).attr('http-equiv') ?? ''));
            const content = normalizeUriForSchemeCheck(String($(el).attr('content') ?? ''));
            if (isDangerousMetaRefresh(httpEquiv, content)) { $(el).remove(); return; }
        }
        if (tag === 'style' && cssHasDangerousConstruct($(el).text())) { $(el).remove(); }
    });

    // Strip active-content attributes (on*, dangerous style/URI) from the
    // structural elements the body-inner allowlist pass does not cover: <html>,
    // <head>, <body>, and the head children kept above (e.g. a <body onload=...>).
    $('html, head, body, head > *').each((_, el) => {
        const attribs = $(el).attr() ?? {};
        for (const name of Object.keys(attribs)) {
            const lname = name.toLowerCase();
            const value = normalizeUriForSchemeCheck(String(attribs[name]));
            if (lname.startsWith('on')) {
                $(el).removeAttr(name);
            } else if (lname === 'style' && cssHasDangerousConstruct(String(attribs[name]))) {
                $(el).removeAttr(name);
            } else if (URI_BEARING_ATTRIBUTES.has(lname) && isDangerousUriScheme(value)) {
                $(el).removeAttr(name);
            }
        }
    });

    return $.html();
}

