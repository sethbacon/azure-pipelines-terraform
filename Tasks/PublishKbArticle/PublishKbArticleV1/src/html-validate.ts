import * as fs from 'fs';
import { load } from 'cheerio';
import { normalizeUriForSchemeCheck, isDangerousUriScheme, isDangerousMetaRefresh, URI_BEARING_ATTRIBUTES } from './uri-scheme-guard';

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
        const msg = 'HTML parsing resulted in significant content loss, possible syntax errors';
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
        throw new Error('External script sources are not allowed in KB articles');
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
        throw new Error('Inline <script> elements are not allowed in KB articles');
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
        throw new Error('<base> elements and <meta http-equiv="refresh"> redirects to javascript:/vbscript: are not allowed in KB articles');
    }

    // Reject inline event-handler attributes (onerror=, onload=, onclick=, …)
    // and javascript:/vbscript:/non-image data: URIs — stored-XSS vectors the
    // external <script src> check above does not cover.
    let eventHandlerFound = false;
    let dangerousUriFound = false;
    $('*').each((_, el) => {
        const attribs = $(el).attr() ?? {};
        for (const name of Object.keys(attribs)) {
            const lname = name.toLowerCase();
            const value = normalizeUriForSchemeCheck(String(attribs[name]));
            if (lname.startsWith('on')) {
                eventHandlerFound = true;
            } else if (
                URI_BEARING_ATTRIBUTES.has(lname) &&
                isDangerousUriScheme(value)
            ) {
                dangerousUriFound = true;
            }
        }
    });

    if (eventHandlerFound) {
        throw new Error('Inline event-handler attributes (on*) are not allowed in KB articles');
    }

    if (dangerousUriFound) {
        throw new Error('javascript:, vbscript: and non-image data: URIs are not allowed in KB articles');
    }
}

/**
 * Read an HTML file from disk. Throws if the file does not exist.
 */
export function readHtmlFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File '${filePath}' not found.`);
    }
    return fs.readFileSync(filePath, 'utf-8');
}
