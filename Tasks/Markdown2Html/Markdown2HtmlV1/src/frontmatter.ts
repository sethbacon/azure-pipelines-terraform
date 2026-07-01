/**
 * Front-matter parser.
 * Ports parse_yaml_front_matter + _parse_simple_yaml from md2html_converter.py.
 * Uses js-yaml for robust YAML parsing (strict superset of the hand-rolled parser).
 */

import fs = require('fs');
import yaml = require('js-yaml');

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
    return parseFrontMatterFromString(content);
}

/**
 * Parse YAML front-matter from a string (exported for testing).
 * Mirrors the regex: ^---\r?\n(.*?)\r?\n---\r?\n? with re.DOTALL
 */
export function parseFrontMatterFromString(content: string): FrontMatterResult {
    // Handle both LF and CRLF
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) {
        return { data: {}, body: content };
    }

    const yamlText = match[1];
    const body = content.slice(match[0].length);

    let data: Record<string, unknown>;
    try {
        const parsed = yaml.load(yamlText);
        data = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
    } catch {
        data = {};
    }

    return { data, body };
}
