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
