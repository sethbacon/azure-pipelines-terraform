import * as fs from 'fs';
import tasks = require('azure-pipelines-task-lib/task');
import { isValidSysId } from './image-rewrite';

/**
 * Collapse any newline-family character (CR, LF, CRLF, and the Unicode
 * line/paragraph separators U+2028/U+2029 -- a JSON \u-escape can carry one
 * of the latter two through JSON.parse just like \n) in a value about to be
 * interpolated into a single-line console/manifest log line. The
 * `##[manifest] ...` line (and PublishKbArticleV1's ArticleNumberLine/
 * ArticleIdLine/WorkflowStateLine lines) are meant to be exactly one line
 * each -- without this, an embedded newline in an author/ServiceNow-supplied
 * field could smuggle in a fake ##vso[...]/##[...] logging command that the
 * agent would then interpret as a separate line (#693).
 */
export function sanitizeForSingleLineEcho(value: string): string {
    return value.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
}

/** Append an article entry to the kb-manifest JSON file. */
export function appendToManifest(manifestPath: string, entry: Record<string, unknown>): void {
    let entries: unknown[] = [];
    // Opened once and read via that same descriptor (not an existsSync +
    // readFileSync pair on the path) so there is no window between the
    // existence check and the read where the path could be repointed at a
    // different file (TOCTOU / CWE-367).
    let fd: number | undefined;
    try {
        fd = fs.openSync(manifestPath, 'r');
    } catch {
        fd = undefined; // Missing (or otherwise unopenable) -- start from an empty manifest.
    }
    if (fd !== undefined) {
        try {
            entries = JSON.parse(fs.readFileSync(fd, 'utf-8'));
        } catch (e: unknown) {
            // The manifest exists but is unreadable/corrupt. Do NOT silently reset it
            // to [] -- that would overwrite and permanently discard every prior article
            // mapping. Preserve the original as a timestamped .bak and warn loudly so
            // the prior entries can be recovered.
            const backup = `${manifestPath}.corrupt-${Date.now()}.bak`;
            try {
                fs.renameSync(manifestPath, backup);
                console.warn(tasks.loc('ManifestCorruptBackedUp', manifestPath, e, backup));
            } catch {
                console.warn(tasks.loc('ManifestCorruptNoBackup', manifestPath, e));
            }
            entries = [];
        } finally {
            fs.closeSync(fd);
        }
    }
    entries.push(entry);
    try {
        fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2), 'utf-8');
        console.log(tasks.loc('ManifestUpdated', manifestPath));
    } catch (e: unknown) {
        // Deliberately non-fatal: the ServiceNow write already succeeded, so
        // failing here would be misleading. Surfaced as a pipeline warning
        // (visible in the build summary) rather than a console line, because a
        // lost manifest entry can mean a later run without a sourceKey fails to
        // resolve this article and creates a duplicate (#564).
        tasks.warning(tasks.loc('ManifestWriteFailed', manifestPath, e));
    }
}

/** Write article info to a KB<number>.json file (legacy mode). */
export function outputArticleInfoToJson(article: Record<string, unknown>): void {
    const number = (article['number'] as string) || 'article_info';
    const filename = `${number}.json`;
    const info = {
        article_id: article['sys_id'],
        kb_id: article['kb_knowledge_base'],
        number,
        title: article['short_description'],
        workflow_state: article['workflow_state'],
        author: article['author'],
    };
    try {
        fs.writeFileSync(filename, JSON.stringify(info, null, 2), 'utf-8');
        console.log(tasks.loc('ArticleInfoSaved', filename));
    } catch (e: unknown) {
        // Same deliberate non-fatal tradeoff as appendToManifest above: the
        // legacy KB<number>.json is the lookup mechanism for later runs, so a
        // lost write is surfaced as a pipeline warning (#564).
        tasks.warning(tasks.loc('ArticleInfoSaveFailed', e));
    }
}

/**
 * Emit the backward-compatible manifest log line to stdout, then either
 * append to manifest file (new mode) or write legacy KB*.json file.
 */
export function emitArticleOutput(
    article: Record<string, unknown>,
    sourceKey: string | undefined,
    manifestPath: string | undefined,
    kbId: string | undefined,
): void {
    const sysId = article['sys_id'] as string;
    const number = article['number'] as string;

    if (sourceKey) {
        // The article's own sys_id comes from the same (semi-trusted) ServiceNow
        // response as an attachment sys_id -- validate it with the same strict
        // 32-hex-char check the URL/HTML sinks already use (image-rewrite.ts),
        // and neutralize embedded newlines in every interpolated field, before
        // echoing this single-line log entry (#693). Only the ECHOED copy is
        // validated/sanitized this way -- the manifest file entry below keeps
        // the raw values so a merely format-surprising (but real) sys_id is
        // never corrupted in the persisted duplicate-detection record.
        const sysIdForEcho = isValidSysId(sysId) ? sysId : '(invalid-sys_id)';
        if (sysIdForEcho === '(invalid-sys_id)') {
            tasks.warning(tasks.loc('ArticleSysIdInvalidForEcho', sysId));
        }
        // Log-scrapers depend on this exact format — do not change.
        process.stdout.write(`##[manifest] source_key=${sanitizeForSingleLineEcho(sourceKey)} sys_id=${sysIdForEcho} number=${sanitizeForSingleLineEcho(number)}\n`);
    }

    if (manifestPath) {
        const kbField = article['kb_knowledge_base'];
        let resolvedKb = kbId;
        if (!resolvedKb) {
            if (typeof kbField === 'object' && kbField !== null) {
                resolvedKb = (kbField as { value: string }).value;
            } else {
                resolvedKb = kbField as string;
            }
        }
        appendToManifest(manifestPath, {
            source_key: sourceKey,
            sys_id: sysId,
            number,
            kb_id: resolvedKb,
            title: article['short_description'],
            workflow_state: article['workflow_state'],
        });
    } else {
        outputArticleInfoToJson(article);
    }
}

/**
 * Matches only the filenames this task's own legacy `outputArticleInfoToJson`
 * writes: `KB<number>.json` (ServiceNow KB article numbers, e.g. KB0001234) or
 * the `article_info.json` fallback used when the article has no number yet.
 */
const KB_ARTICLE_JSON_NAME_RE = /^(KB\S*|article_info)\.json$/i;

/**
 * Find a KB article JSON file in the current working directory.
 * Returns parsed data if a file with `article_id` is found, null otherwise.
 *
 * Only filenames matching the exact convention this task's own legacy writer
 * uses (KB_ARTICLE_JSON_NAME_RE) are considered — an earlier, unrelated build
 * step could otherwise drop an arbitrary *.json file into the working
 * directory (e.g. a stray manifest, lockfile-adjacent artifact, or a
 * maliciously-placed file) and, with no filename pinning, have it picked up
 * as the KB article identity source (a confused-deputy risk: this function
 * feeds directly into which ServiceNow article gets updated). When more than
 * one matching file is present, the most recently modified one is used (not
 * directory-listing order, which is filesystem-dependent and not meaningful).
 */
export function findKbArticleJson(): Record<string, unknown> | null {
    let jsonFiles: string[];
    try {
        jsonFiles = fs.readdirSync('.').filter(f => KB_ARTICLE_JSON_NAME_RE.test(f));
    } catch {
        return null;
    }
    const candidates: { filename: string; mtimeMs: number; data: Record<string, unknown> }[] = [];
    for (const filename of jsonFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
            if (data['article_id']) {
                candidates.push({ filename, mtimeMs: fs.statSync(filename).mtimeMs, data });
            }
        } catch {
            continue;
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length > 1) {
        console.warn(tasks.loc('MultipleKbJsonFilesFound', candidates.map(c => c.filename).join(', ')));
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    console.log(tasks.loc('FoundKbJsonFile', candidates[0].filename));
    return candidates[0].data;
}

/**
 * Extract the `kb-key:` value from the YAML front-matter of a markdown file.
 * Throws if the file cannot be read or the key is missing.
 */
export function readFrontMatterKey(filepath: string): string {
    let content: string;
    try {
        content = fs.readFileSync(filepath, 'utf-8');
    } catch (e: unknown) {
        throw new Error(`Error reading '${filepath}': ${e}`);
    }

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
        throw new Error(`No YAML front-matter found in '${filepath}'.`);
    }

    const frontMatter = match[1];
    const keyMatch = frontMatter.match(/^kb-key:\s*(.+)$/m);
    if (!keyMatch) {
        throw new Error(`No 'kb-key:' field found in front-matter of '${filepath}'.`);
    }

    return keyMatch[1].trim().replace(/^["']|["']$/g, '');
}
