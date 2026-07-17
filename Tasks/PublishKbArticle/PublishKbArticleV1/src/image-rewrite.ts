/**
 * Image reference extraction and rewriting for the article body.
 *
 * Finds relative <img src> references in the HTML, and rewrites each to a
 * ServiceNow attachment URL (`sys_attachment.do?sys_id=<id>`). Absolute URLs
 * (http/https/protocol-relative/data:) are left untouched.
 */

import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');

export interface LocalImageRef {
    /** The original src string as it appears in the HTML. */
    originalSrc: string;
    /** Absolute path to the local image file. */
    absPath: string;
    /** Base name used as the attachment file_name. */
    fileName: string;
}

/** True for srcs that must NOT be touched (already absolute / non-file). */
function isExternalSrc(src: string): boolean {
    return /^(https?:)?\/\//i.test(src) || /^data:/i.test(src) || src.startsWith('#');
}

/**
 * Extract distinct relative <img src> references from the HTML body, resolved
 * against imageBaseDir. Skips external/data srcs. De-duplicates by absolute path.
 */
export function extractLocalImageRefs(
    html: string,
    imageBaseDir: string,
    log: (msg: string) => void = console.log,
): LocalImageRef[] {
    const refs = new Map<string, LocalImageRef>();
    const base = path.resolve(imageBaseDir);
    const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(['"])(.*?)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(html)) !== null) {
        const src = m[2].trim();
        if (!src || isExternalSrc(src)) continue;

        // Strip any query/fragment from the local path (e.g. ./a.png?x=1).
        const cleanPath = src.replace(/[?#].*$/, '');
        // decodeURIComponent throws a URIError on a malformed percent-escape
        // (e.g. src="bad%" or "%ZZ"). The article body is author/upstream
        // controlled, so an unguarded call would abort the entire publish on one
        // bad reference. Skip the ref (leaving its src untouched in the body),
        // mirroring the missing-file skip below, instead of failing the run
        // (#605).
        let decodedPath: string;
        try {
            decodedPath = decodeURIComponent(cleanPath);
        } catch {
            log(tasks.loc('ImageSrcMalformedEncoding', src));
            continue;
        }
        const absPath = path.resolve(imageBaseDir, decodedPath);

        // Containment guard: reject any src (e.g. `../secret.png` or its
        // URL-encoded form) that resolves outside imageBaseDir. Without this, a
        // path-traversal src could read and upload an arbitrary file on the
        // agent as a KB attachment.
        if (absPath !== base && !absPath.startsWith(base + path.sep)) {
            log(tasks.loc('ImageSrcOutsideBaseDir', src, absPath, base));
            continue;
        }

        if (!refs.has(absPath)) {
            refs.set(absPath, {
                originalSrc: src,
                absPath,
                fileName: path.basename(absPath),
            });
        }
    }
    return [...refs.values()];
}

/**
 * Rewrite every occurrence of each original src to its attachment URL.
 * `srcToAttachmentId` maps the ORIGINAL src string -> attachment sys_id.
 * Unmapped srcs (e.g. a missing file that was skipped) are left as-is.
 */
export function rewriteImageSrcs(
    html: string,
    srcToAttachmentId: Map<string, string>,
): string {
    if (srcToAttachmentId.size === 0) return html;

    return html.replace(
        /(<img\b[^>]*?\bsrc\s*=\s*)(['"])(.*?)\2/gi,
        (full, prefix, quote, src) => {
            const id = srcToAttachmentId.get((src as string).trim());
            if (!id) return full;
            // The id is a ServiceNow-returned attachment sys_id interpolated
            // straight into a quoted src attribute of the re-published article
            // body. Its upstream producers (uploadAttachment / the reuse path's
            // match.sys_id from listArticleAttachments) assert only that it is a
            // string, not its charset — a hostile or corrupted backend response
            // such as `"><img src=x onerror=...>` would otherwise break out of
            // the attribute and inject markup into the stored article. This is
            // the single choke point every sys_id (upload AND reuse path) passes
            // through before interpolation, so validate the expected 32-char hex
            // GUID here and fail closed on anything else (#606).
            if (!/^[0-9a-f]{32}$/i.test(id)) {
                throw new Error(tasks.loc('AttachmentSysIdInvalid', id));
            }
            // Root-relative URL (leading slash) — this is the form ServiceNow's own
            // KB articles use to embed attachment images, and it resolves correctly
            // regardless of the page path the article renders under.
            return `${prefix}${quote}/sys_attachment.do?sys_id=${id}${quote}`;
        },
    );
}
