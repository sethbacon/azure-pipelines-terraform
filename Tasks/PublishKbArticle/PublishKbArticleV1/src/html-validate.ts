import * as fs from 'fs';
import { load } from 'cheerio';
import { normalizeUriForSchemeCheck, isDangerousUriScheme, isDangerousMetaRefresh, URI_BEARING_ATTRIBUTES, DANGEROUS_TAGS, DANGEROUS_CSS_PATTERN, normalizeCssForDangerCheck } from './uri-scheme-guard';
import tasks = require('azure-pipelines-task-lib/task');

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
    // it too). The CSS text is run through normalizeCssForDangerCheck first so a
    // browser-decoded escape (`\75rl(...)`, `@\69mport`) or a comment-split
    // (`url` `(` separated by a CSS comment) can't slip a fetch past this
    // raw-text pattern (#587).
    let dangerousStyleContentFound = false;
    $('style').each((_, el) => {
        if (DANGEROUS_CSS_PATTERN.test(normalizeCssForDangerCheck($(el).text()))) {
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
    // it is checked against the same shared DANGEROUS_CSS_PATTERN, on the
    // cheerio-decoded value normalized by normalizeCssForDangerCheck (CSS-escape
    // decode + comment strip) for parity with that element-content check and to
    // close the same browser-tokenizer bypass (#587).
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
            } else if (lname === 'style' && DANGEROUS_CSS_PATTERN.test(normalizeCssForDangerCheck(String(attribs[name])))) {
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
 * Read an HTML file from disk. Throws if the file does not exist.
 */
export function readHtmlFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
        throw new Error(tasks.loc('HtmlFileNotFound', filePath));
    }
    return fs.readFileSync(filePath, 'utf-8');
}
