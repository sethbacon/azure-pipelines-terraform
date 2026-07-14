/**
 * Include resolver.
 * Ports resolve_includes from md2html_converter.py — exact semantics preserved.
 */

import fs = require('fs');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import { parseFrontMatter } from './frontmatter';

export const MAX_INCLUDE_DEPTH = 5;

/**
 * Recursively resolve the includes: list from front-matter.
 * Returns an ordered list of absolute paths to include (primary itself excluded).
 * Throws on cycles, depth exceeded, missing files, or include with kb-key.
 */
export function resolveIncludes(
    primaryPath: string,
    frontMatter: Record<string, unknown>,
    visited: Set<string> = new Set<string>(),
    depth: number = 0
): string[] {
    if (depth > MAX_INCLUDE_DEPTH) {
        throw new Error(tasks.loc('MaxIncludeDepthExceeded', MAX_INCLUDE_DEPTH, primaryPath));
    }

    const absPrimary = path.resolve(primaryPath);
    const primaryDir = path.dirname(absPrimary);

    // Immutable-style update: create a new set with absPrimary added
    const visitedNow = new Set(visited);
    visitedNow.add(absPrimary);

    const includesList = (frontMatter['includes'] as string[] | undefined) ?? [];
    const result: string[] = [];
    const seenInResult = new Set<string>();

    for (const includeRel of includesList) {
        const absInclude = path.resolve(path.join(primaryDir, includeRel));

        // Containment guard: an include must resolve within primaryDir (or a
        // subdirectory of it). Without this, an `includes:` entry such as
        // '../../secret.md' would pull an arbitrary readable file on the build
        // agent into the rendered/published KB article.
        const relToPrimaryDir = path.relative(primaryDir, absInclude);
        if (relToPrimaryDir === '..' || relToPrimaryDir.startsWith(`..${path.sep}`) || path.isAbsolute(relToPrimaryDir)) {
            throw new Error(tasks.loc('IncludeOutsidePrimaryDir', includeRel, primaryDir, absInclude));
        }

        if (!fs.existsSync(absInclude) || !fs.statSync(absInclude).isFile()) {
            throw new Error(tasks.loc('IncludeFileNotFound', includeRel, absInclude));
        }

        if (seenInResult.has(absInclude)) {
            // Duplicate — skip silently (Python prints a warning, we just skip)
            continue;
        }

        if (visitedNow.has(absInclude)) {
            throw new Error(tasks.loc('IncludeCycleDetected', includeRel));
        }

        const { data: incFm } = parseFrontMatter(absInclude);
        if (incFm['kb-key']) {
            throw new Error(tasks.loc('IncludeHasKbKey', includeRel));
        }

        seenInResult.add(absInclude);
        result.push(absInclude);

        // Recursively flatten nested includes
        if (incFm['includes']) {
            for (const sub of resolveIncludes(absInclude, incFm, visitedNow, depth + 1)) {
                if (!seenInResult.has(sub)) {
                    seenInResult.add(sub);
                    result.push(sub);
                }
            }
        }
    }

    return result;
}
