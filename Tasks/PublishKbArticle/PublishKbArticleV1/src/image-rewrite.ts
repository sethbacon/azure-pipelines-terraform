/**
 * Image reference extraction and rewriting for the article body.
 *
 * Finds relative <img src> references in the HTML, and rewrites each to a
 * ServiceNow attachment URL (`sys_attachment.do?sys_id=<id>`). Absolute URLs
 * (http/https/protocol-relative/data:) are left untouched.
 */

import * as path from 'path';

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
        const absPath = path.resolve(imageBaseDir, decodeURIComponent(cleanPath));

        // Containment guard: reject any src (e.g. `../secret.png` or its
        // URL-encoded form) that resolves outside imageBaseDir. Without this, a
        // path-traversal src could read and upload an arbitrary file on the
        // agent as a KB attachment.
        if (absPath !== base && !absPath.startsWith(base + path.sep)) {
            log(`[WARN] Skipping image src '${src}': resolves outside the image base directory ('${absPath}' is not under '${base}').`);
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
            // Root-relative URL (leading slash) — this is the form ServiceNow's own
            // KB articles use to embed attachment images, and it resolves correctly
            // regardless of the page path the article renders under.
            return `${prefix}${quote}/sys_attachment.do?sys_id=${id}${quote}`;
        },
    );
}
