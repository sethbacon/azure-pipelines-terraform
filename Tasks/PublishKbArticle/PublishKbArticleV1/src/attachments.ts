/**
 * ServiceNow attachment client + image upload orchestration.
 *
 * Images referenced by relative <img src> in the article body are uploaded as
 * ServiceNow attachments on the kb_knowledge record, and the src is rewritten to
 * a relative `sys_attachment.do?sys_id=<id>` URL (render-safe for any
 * authenticated KB reader).
 *
 * Idempotency: match-by-filename-replace-if-changed. Before uploading, the
 * existing attachments on the article are listed; if one with the same file name
 * exists and its content hash matches, it is reused; if the hash differs, the old
 * one is deleted and the new content uploaded.
 *
 * Verified against a live ServiceNow instance (2026-06-01): the CEAAPI basic-auth
 * account can POST and DELETE attachments; the REST file endpoint serves the bytes.
 */

import { snRequest, withRetry } from './servicenow-http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import tasks = require('azure-pipelines-task-lib/task');
import { baseUrl, assertQueryValueSafe } from './servicenow-client';
import { extractLocalImageRefs, rewriteImageSrcs } from './image-rewrite';

export interface SnAttachment {
    sys_id: string;
    file_name: string;
    content_type?: string;
    hash?: string;
    size_bytes?: string;
}

/** List attachments on a kb_knowledge record. */
export async function listArticleAttachments(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
): Promise<SnAttachment[]> {
    assertQueryValueSafe(articleId, 'article id');
    const url = `${baseUrl(instance)}/api/now/attachment`;
    const params = {
        sysparm_query: `table_name=kb_knowledge^table_sys_id=${articleId}`,
        sysparm_fields: 'sys_id,file_name,content_type,hash,size_bytes',
    };
    const response = await snRequest('GET', url, { headers, params });
    return (response.data.result || []) as SnAttachment[];
}

/** Upload a file as an attachment on a kb_knowledge record. Returns the new attachment sys_id. */
export async function uploadAttachment(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    filePath: string,
    fileName: string,
    contentType: string,
): Promise<string> {
    const url = `${baseUrl(instance)}/api/now/attachment/file`;
    const data = fs.readFileSync(filePath);
    // Attachment upload uses the binary body + the file's own content type, NOT
    // the JSON Content-Type from the shared headers. Copy auth/accept only.
    const uploadHeaders: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': contentType,
    };
    if (headers['Authorization']) uploadHeaders['Authorization'] = headers['Authorization'];

    const response = await withRetry(() => snRequest('POST', url, {
        headers: uploadHeaders,
        params: { table_name: 'kb_knowledge', table_sys_id: articleId, file_name: fileName },
        body: data,
    }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
    return (response.data.result as { sys_id: string }).sys_id;
}

/** Delete an attachment by sys_id. */
export async function deleteAttachment(
    instance: string,
    headers: Record<string, string>,
    attachmentId: string,
): Promise<void> {
    const url = `${baseUrl(instance)}/api/now/attachment/${attachmentId}`;
    await snRequest('DELETE', url, { headers });
}

/** SHA-256 hex hash of a file's bytes (matches the ServiceNow attachment `hash` field). */
export function fileSha256(filePath: string): string {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

const CONTENT_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
};

export function contentTypeFor(fileName: string): string {
    return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

/**
 * Ensure a local image file is attached to the article, reusing an existing
 * attachment when its content hash matches, replacing it when it differs.
 * Returns the attachment sys_id to reference in the rewritten <img src>.
 */
export async function syncImageAttachment(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    filePath: string,
    fileName: string,
    existing: SnAttachment[],
): Promise<string> {
    const localHash = fileSha256(filePath);
    const match = existing.find((a) => a.file_name === fileName);

    if (match && match.hash && match.hash === localHash) {
        // Identical content already attached — reuse.
        return match.sys_id;
    }

    // Upload the replacement first, and only delete the old attachment (if any)
    // after the upload succeeds. Deleting first (the previous order) left no
    // rollback path if the subsequent upload failed -- self-healing either way
    // on the next pipeline re-run (the article is re-resolved by sourceKey and
    // the local source file is never touched), but this avoids a window where
    // the image is briefly missing from the article.
    const newId = await uploadAttachment(
        instance, headers, articleId, filePath, fileName, contentTypeFor(fileName),
    );
    if (match) {
        // Retried (#509) the same as uploadAttachment above -- deleteAttachment
        // previously had no retry of its own. This is deliberately a retry of the
        // single DELETE call, not of syncImageAttachment as a whole: retrying the
        // whole function (which processArticleImages did in an earlier version of
        // this change) re-runs the already-succeeded upload step too on every
        // retry attempt -- since `existing` is a snapshot captured once before the
        // loop and never refreshed, a transient failure on delete would silently
        // accumulate duplicate attachments instead of safely retrying the one
        // call that actually failed.
        await withRetry(() => deleteAttachment(instance, headers, match.sys_id), {
            log: (message) => console.log(`[WARN] ${message}`),
        });
    }
    return newId;
}

export interface ProcessImagesResult {
    /** Body HTML with relative <img src> rewritten to attachment URLs. */
    html: string;
    /** Number of images uploaded or reused. */
    uploaded: number;
    /** Original srcs that were skipped because the file was missing. */
    missing: string[];
}

/**
 * Upload all relative <img> images referenced in `html` as attachments on the
 * article and return the body with those srcs rewritten to attachment URLs.
 *
 * - Resolves relative srcs against imageBaseDir.
 * - Uses match-by-filename-replace-if-changed idempotency (syncImageAttachment).
 * - Missing files: skipped (left as-is in the body) unless `failOnMissing`.
 */
export async function processArticleImages(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    html: string,
    imageBaseDir: string,
    failOnMissing: boolean,
    log: (msg: string) => void = console.log,
): Promise<ProcessImagesResult> {
    const refs = extractLocalImageRefs(html, imageBaseDir, log);
    if (refs.length === 0) {
        return { html, uploaded: 0, missing: [] };
    }

    const existing = await listArticleAttachments(instance, headers, articleId);
    const srcToId = new Map<string, string>();
    const missing: string[] = [];
    let uploaded = 0;

    try {
        for (const ref of refs) {
            if (!fs.existsSync(ref.absPath)) {
                const msg = tasks.loc('ImageNotFound', ref.originalSrc, ref.absPath);
                if (failOnMissing) {
                    throw new Error(msg);
                }
                log(`[WARN] ${msg}`);
                missing.push(ref.originalSrc);
                continue;
            }
            // syncImageAttachment's own upload/delete network calls are each
            // individually wrapped in withRetry (#509) to reduce spurious mid-loop
            // failures on a transient ServiceNow/network blip -- without that, a
            // single failed image in the middle of a multi-image article aborts the
            // whole loop (and the caller's subsequent updateArticleBody rewrite
            // never runs), even though every image already uploaded in this run is
            // self-healing on the next pipeline re-run via syncImageAttachment's
            // filename-based idempotency. Retrying at the individual-call level
            // (rather than wrapping this whole call) avoids re-running an
            // already-succeeded upload on a retry of a later step -- see
            // syncImageAttachment's comment.
            const attachmentId = await syncImageAttachment(
                instance, headers, articleId, ref.absPath, ref.fileName, existing,
            );
            srcToId.set(ref.originalSrc, attachmentId);
            uploaded++;
            log(tasks.loc('ImageAttached', ref.fileName, attachmentId));
        }
    } catch (err) {
        // If the loop aborts mid-way (a missing file with failOnMissing, or a
        // retry-exhausted ServiceNow error), the images uploaded so far are real,
        // already-attached ServiceNow records -- surface them as a warning so an
        // operator isn't surprised by attached-but-unlinked attachments before the
        // next run's idempotent re-sync catches up (#509).
        if (srcToId.size > 0) {
            const uploadedNames = refs
                .filter((ref) => srcToId.has(ref.originalSrc))
                .map((ref) => ref.fileName)
                .join(', ');
            tasks.warning(tasks.loc('ImagesUploadedBeforeAbort', srcToId.size, uploadedNames));
        }
        throw err;
    }

    return { html: rewriteImageSrcs(html, srcToId), uploaded, missing };
}
