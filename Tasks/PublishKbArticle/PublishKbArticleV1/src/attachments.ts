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

import { snRequest } from './servicenow-http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { baseUrl } from './servicenow-client';
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

    const response = await snRequest('POST', url, {
        headers: uploadHeaders,
        params: { table_name: 'kb_knowledge', table_sys_id: articleId, file_name: fileName },
        body: data,
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

    if (match) {
        if (match.hash && match.hash === localHash) {
            // Identical content already attached — reuse.
            return match.sys_id;
        }
        // Same name, different content — replace.
        await deleteAttachment(instance, headers, match.sys_id);
    }

    return uploadAttachment(
        instance, headers, articleId, filePath, fileName, contentTypeFor(fileName),
    );
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
    const refs = extractLocalImageRefs(html, imageBaseDir);
    if (refs.length === 0) {
        return { html, uploaded: 0, missing: [] };
    }

    const existing = await listArticleAttachments(instance, headers, articleId);
    const srcToId = new Map<string, string>();
    const missing: string[] = [];
    let uploaded = 0;

    for (const ref of refs) {
        if (!fs.existsSync(ref.absPath)) {
            const msg = `Image not found, leaving src unchanged: '${ref.originalSrc}' (resolved to '${ref.absPath}')`;
            if (failOnMissing) {
                throw new Error(msg);
            }
            log(`[WARN] ${msg}`);
            missing.push(ref.originalSrc);
            continue;
        }
        const attachmentId = await syncImageAttachment(
            instance, headers, articleId, ref.absPath, ref.fileName, existing,
        );
        srcToId.set(ref.originalSrc, attachmentId);
        uploaded++;
        log(`[INFO] Attached image '${ref.fileName}' -> sys_attachment.do?sys_id=${attachmentId}`);
    }

    return { html: rewriteImageSrcs(html, srcToId), uploaded, missing };
}
