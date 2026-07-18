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
 * ServiceNow sys_ids are 32-character hex GUIDs. Every attachment sys_id this
 * task ever interpolates into a URL or HTML attribute — whether returned by a
 * fresh upload (attachments.ts's uploadAttachment) or reused from a
 * list-attachments response (attachments.ts's listArticleAttachments) — is
 * validated against this shape at the point its producer parses the
 * ServiceNow response, before the value can reach ANY downstream sink. This
 * is the single implementation both attachments.ts (the URL sink:
 * deleteAttachment's path segment) and rewriteImageSrcs below (the HTML sink:
 * the rewritten `<img src>`) call — a hostile or corrupted backend response
 * (e.g. `"><img src=x onerror=...>`, or a path-traversal value like
 * `x/../table/kb_knowledge/<victimId>`) fails closed here rather than at
 * whichever sink happens to consume it later (#606 follow-up).
 */
export function isValidSysId(id: string): boolean {
    return /^[0-9a-f]{32}$/i.test(id);
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
            // Belt-and-suspenders: attachments.ts's producers (uploadAttachment,
            // listArticleAttachments) already validate every sys_id with
            // isValidSysId at the point their ServiceNow response is parsed, so
            // this should never trip in practice — but this is the actual
            // interpolation site, so it stays a hard fail-closed check rather
            // than relying solely on an upstream caller having done it (#606).
            if (!isValidSysId(id)) {
                throw new Error(tasks.loc('AttachmentSysIdInvalid', id));
            }
            // Root-relative URL (leading slash) — this is the form ServiceNow's own
            // KB articles use to embed attachment images, and it resolves correctly
            // regardless of the page path the article renders under.
            return `${prefix}${quote}/sys_attachment.do?sys_id=${id}${quote}`;
        },
    );
}
