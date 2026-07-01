import * as fs from 'fs';

/** Append an article entry to the kb-manifest JSON file. */
export function appendToManifest(manifestPath: string, entry: Record<string, unknown>): void {
    let entries: unknown[] = [];
    if (fs.existsSync(manifestPath)) {
        try {
            entries = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
            entries = [];
        }
    }
    entries.push(entry);
    try {
        fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2), 'utf-8');
        console.log(`Manifest updated: ${manifestPath}`);
    } catch (e: unknown) {
        console.warn(`Warning: Could not write manifest '${manifestPath}': ${e}`);
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
        console.log(`Article information saved to ${filename}`);
    } catch (e: unknown) {
        console.error(`Error saving article information to JSON file: ${e}`);
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
        // Log-scrapers depend on this exact format — do not change.
        process.stdout.write(`##[manifest] source_key=${sourceKey} sys_id=${sysId} number=${number}\n`);
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
 * Find a KB article JSON file in the current working directory.
 * Returns parsed data if a file with `article_id` is found, null otherwise.
 */
export function findKbArticleJson(): Record<string, unknown> | null {
    let jsonFiles: string[];
    try {
        jsonFiles = fs.readdirSync('.').filter(f => f.endsWith('.json'));
    } catch {
        return null;
    }
    for (const filename of jsonFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
            if (data['article_id']) {
                console.log(`Found KB article JSON file: ${filename}`);
                return data as Record<string, unknown>;
            }
        } catch {
            continue;
        }
    }
    return null;
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
