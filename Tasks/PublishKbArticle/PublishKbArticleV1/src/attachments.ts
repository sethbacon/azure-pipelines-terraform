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
import { extractLocalImageRefs, rewriteImageSrcs, isValidSysId } from './image-rewrite';

/**
 * Upper bound on a single local image file read into memory before hashing/
 * uploading (#677). A relative <img src> resolves to a semi-trusted,
 * author-controlled local file with no size input to bound it otherwise;
 * this matches the 10MB cap every HTTP client in this codebase already
 * applies to a comparable class of read (CWE-400).
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
    // Idempotent read: retried like every other GET in this task (#561), and the
    // response shape validated rather than cast -- servicenow-http.ts defaults a
    // non-JSON 2xx body (e.g. a proxy/WAF intercept) to `{}`, which the previous
    // `(response.data.result || [])` cast passed through as `{}` and crashed the
    // caller's `.find()` with a bare TypeError instead of a clear diagnostic.
    const response = await withRetry(() => snRequest('GET', url, { headers, params }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
    const result = response.data.result;
    if (!Array.isArray(result)) {
        throw new Error(tasks.loc('AttachmentListNotArray', articleId));
    }
    // Trust-boundary validation: every attachment sys_id in this response is
    // validated against the 32-char hex GUID shape (isValidSysId, shared with
    // uploadAttachment below and the HTML sink in image-rewrite.ts) right
    // here, at the point the response is parsed -- before an element can
    // reach EITHER downstream sink this list feeds: deleteAttachment's URL
    // path segment (syncImageAttachment's replace path, when a filename match
    // has a differing hash) or the rewritten `<img src>` (the reuse path,
    // when the hash matches). A hostile/corrupted backend value such as
    // `x/../table/kb_knowledge/<victimId>` fails closed here rather than at
    // whichever sink happens to consume it later (#606 follow-up: the
    // original fix guarded only the HTML sink, leaving the DELETE call
    // unvalidated).
    for (const attachment of result as SnAttachment[]) {
        if (typeof attachment.sys_id !== 'string' || !isValidSysId(attachment.sys_id)) {
            throw new Error(tasks.loc('AttachmentSysIdInvalid', String(attachment.sys_id)));
        }
    }
    return result as SnAttachment[];
}

/**
 * Upload an attachment on a kb_knowledge record from already-read bytes.
 * Takes the raw `data` Buffer (rather than a file path) so a caller that also
 * needs to hash the same file (syncImageAttachment) can read it once and
 * reuse the buffer for both, instead of two separate fs.readFileSync calls
 * (#677). Returns the new attachment sys_id.
 */
export async function uploadAttachment(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    data: Buffer,
    fileName: string,
    contentType: string,
): Promise<string> {
    const url = `${baseUrl(instance)}/api/now/attachment/file`;
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
    // Same 2xx-non-JSON-body fallback as above (#561): validate the result
    // carries a string sys_id before the cast rather than returning undefined,
    // which would silently corrupt the caller's rewritten <img src>.
    const result = response.data.result;
    if (!result || typeof result !== 'object' || typeof (result as { sys_id?: unknown }).sys_id !== 'string') {
        throw new Error(tasks.loc('AttachmentUploadNoSysId', fileName));
    }
    const sysId = (result as { sys_id: string }).sys_id;
    // Trust-boundary validation (#606 follow-up, mirrors listArticleAttachments
    // above): a fresh upload's sys_id feeds the same HTML sink a reused
    // attachment's sys_id does, so it is validated here too, right where this
    // producer parses the response.
    if (!isValidSysId(sysId)) {
        throw new Error(tasks.loc('AttachmentSysIdInvalid', sysId));
    }
    return sysId;
}

/** Delete an attachment by sys_id. */
export async function deleteAttachment(
    instance: string,
    headers: Record<string, string>,
    attachmentId: string,
): Promise<void> {
    // encodeURIComponent guards the path segment as defense-in-depth, matching
    // every other URL sink in servicenow-client.ts (getArticle,
    // updateKnowledgeArticle, updateArticleBody, changeWorkflowState). The
    // primary guard is isValidSysId, which both producers of attachmentId
    // (listArticleAttachments, uploadAttachment above) already enforce at the
    // point their response is parsed -- this is a second, independent layer in
    // case an invalid value ever reached this call some other way.
    const url = `${baseUrl(instance)}/api/now/attachment/${encodeURIComponent(attachmentId)}`;
    await snRequest('DELETE', url, { headers });
}

/** SHA-256 hex hash of a Buffer's bytes (matches the ServiceNow attachment `hash` field). */
function hashBytes(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * SHA-256 hex hash of a file's bytes (matches the ServiceNow attachment `hash`
 * field). Delegates to readAttachmentFile so a direct call also gets the
 * MAX_ATTACHMENT_BYTES cap and the race-free fd-based read (#677) -- kept as
 * its own exported function for callers/tests that only need the hash.
 */
export function fileSha256(filePath: string): string {
    return hashBytes(readAttachmentFile(filePath));
}

/**
 * Reads a local image file into memory once, enforcing MAX_ATTACHMENT_BYTES
 * first so an oversized file is never buffered at all (#677). Opens the file
 * ONE time and stats/reads that same file descriptor (fstat + read, not
 * statSync + readFileSync on the path) so there is no window between the
 * size check and the read where the path could be repointed at a different,
 * larger file (TOCTOU / CWE-367, flagged by CodeQL on the earlier
 * statSync-then-readFileSync version).
 */
function readAttachmentFile(filePath: string): Buffer {
    const fd = fs.openSync(filePath, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (size > MAX_ATTACHMENT_BYTES) {
            throw new Error(tasks.loc('ImageTooLarge', filePath, size, MAX_ATTACHMENT_BYTES));
        }
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, 0);
        return buffer;
    } finally {
        fs.closeSync(fd);
    }
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
    // Read the file once (size-capped) and reuse the same buffer for both the
    // hash and the upload body, instead of two separate fs.readFileSync calls
    // (#677).
    const data = readAttachmentFile(filePath);
    const localHash = hashBytes(data);
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
        instance, headers, articleId, data, fileName, contentTypeFor(fileName),
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
