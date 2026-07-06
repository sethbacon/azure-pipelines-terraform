import * as fs from 'fs';
import { load } from 'cheerio';

/**
 * Validate HTML content for common issues.
 * Throws if invalid and force is false; warns (console) if force is true.
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
        const msg = 'External script sources are not allowed in KB articles';
        if (!force) {
            throw new Error(msg);
        }
        console.warn(`[WARN] HTML validation: ${msg}`);
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
        const msg = 'Inline <script> elements are not allowed in KB articles';
        if (!force) {
            throw new Error(msg);
        }
        console.warn(`[WARN] HTML validation: ${msg}`);
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
            const value = String(attribs[name]).trim().toLowerCase();
            if (lname.startsWith('on')) {
                eventHandlerFound = true;
            } else if (
                (lname === 'href' || lname === 'src' || lname === 'xlink:href' || lname === 'formaction') &&
                (value.startsWith('javascript:') || value.startsWith('vbscript:') || (value.startsWith('data:') && !value.startsWith('data:image/')))
            ) {
                dangerousUriFound = true;
            }
        }
    });

    if (eventHandlerFound) {
        const msg = 'Inline event-handler attributes (on*) are not allowed in KB articles';
        if (!force) {
            throw new Error(msg);
        }
        console.warn(`[WARN] HTML validation: ${msg}`);
    }

    if (dangerousUriFound) {
        const msg = 'javascript:, vbscript: and non-image data: URIs are not allowed in KB articles';
        if (!force) {
            throw new Error(msg);
        }
        console.warn(`[WARN] HTML validation: ${msg}`);
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
