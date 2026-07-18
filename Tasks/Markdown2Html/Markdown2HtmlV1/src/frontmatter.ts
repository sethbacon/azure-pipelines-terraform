/**
 * Front-matter parser.
 * Ports parse_yaml_front_matter + _parse_simple_yaml from md2html_converter.py.
 * Uses js-yaml for robust YAML parsing (strict superset of the hand-rolled parser).
 */

import fs = require('fs');
import yaml = require('js-yaml');
import tasks = require('azure-pipelines-task-lib/task');

export interface FrontMatterResult {
    data: Record<string, unknown>;
    body: string;
}

/**
 * Parse YAML front-matter from a markdown file.
 * Returns { data, body } where body is the content after the front-matter block.
 * data is {} if no front-matter is found.
 * Throws on file read errors.
 */
export function parseFrontMatter(filePath: string): FrontMatterResult {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseFrontMatterFromString(content, filePath);
}

/**
 * Parse YAML front-matter from a string (exported for testing).
 * Mirrors the regex: ^---\r?\n(.*?)\r?\n---\r?\n? with re.DOTALL
 *
 * `source` is used only to label a parse-failure warning (the file path when
 * called via parseFrontMatter); it does not affect parsing.
 */
export function parseFrontMatterFromString(content: string, source = '<front-matter>'): FrontMatterResult {
    // Handle both LF and CRLF
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) {
        return { data: {}, body: content };
    }

    const yamlText = match[1];
    const body = content.slice(match[0].length);

    // A present-but-malformed front-matter block must be distinguishable from
    // "no front-matter at all": both fall back to {}, but only the former is a
    // problem the author should see. Surface a warning (with the file path and
    // the reason) when the block throws or parses to a non-mapping, instead of
    // silently reverting title/order to defaults with no trace in the build log
    // (#604). An empty/comment-only block that yields null/undefined is treated
    // as legitimately-empty metadata (no warning), matching the no-block case.
    let data: Record<string, unknown> = {};
    try {
        const parsed = yaml.load(yamlText);
        if (parsed && typeof parsed === 'object') {
            data = parsed as Record<string, unknown>;
        } else if (parsed !== null && parsed !== undefined) {
            tasks.warning(tasks.loc('FrontMatterParseFailed', source, `expected a YAML mapping but parsed to ${typeof parsed}`));
        }
    } catch (err) {
        tasks.warning(tasks.loc('FrontMatterParseFailed', source, err instanceof Error ? err.message : String(err)));
    }

    return { data, body };
}
