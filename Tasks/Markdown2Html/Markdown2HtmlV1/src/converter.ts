/**
 * Orchestrator functions.
 * Ports process_front_matter_driven and process_files from md2html_converter.py.
 */

import fs = require('fs');
import path = require('path');
import tasks = require('azure-pipelines-task-lib/task');
import { parseFrontMatter } from './frontmatter';
import { resolveIncludes } from './includes';
import {
    convertMarkdownToHtml,
    shiftHeadingLevels,
    buildToc,
    rewriteMdLinks,
    pathToSectionId,
    escapeHtml,
} from './render';
import { generateHtmlDocument } from './document';

export interface FrontMatterOptions {
    titleOverride?: string;
    debug?: boolean;
}

export interface FileListOptions {
    extensions?: string[];
    addSections?: boolean;
    addDividers?: boolean;
    debug?: boolean;
}

/**
 * Parse the raw `inputFiles` task input into a list of paths.
 * Paths may be separated by newlines or commas; surrounding whitespace and
 * empty entries are dropped. (Commas let object-list template parameters be
 * joined into a single input, since pipeline expressions can't emit newlines.)
 */
export function parseFileList(raw: string): string[] {
    return raw
        .split(/[\r\n,]+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

/**
 * Convert a primary markdown file (plus any declared includes) to a single HTML file.
 * Ports process_front_matter_driven.
 * Returns { title, relativeIncludes }.
 */
export async function processFrontMatterDriven(
    primaryPath: string,
    outputPath: string,
    options: FrontMatterOptions = {}
): Promise<{ title: string; relativeIncludes: string[] }> {
    const absPrimary = path.resolve(primaryPath);
    const primaryDir = path.dirname(absPrimary);

    const { data: frontMatter, body: primaryBody } = parseFrontMatter(absPrimary);

    // Title resolution
    let title = options.titleOverride ?? (frontMatter['title'] as string | undefined) ?? '';
    if (!title) {
        const h1Match = primaryBody.match(/^#\s+(.+)$/m);
        title = h1Match
            ? h1Match[1].trim()
            : path.basename(absPrimary, path.extname(absPrimary));
    }

    // Include options
    const incOpts = (frontMatter['include-options'] as Record<string, unknown> | undefined) ?? {};
    const tocEnabled = Boolean(incOpts['toc'] ?? false);
    const separator = String(incOpts['separator'] ?? 'hr');
    const headingShift = Number(incOpts['heading-shift'] ?? 0);
    const sectionAnchors = Boolean(incOpts['section-anchors'] ?? false);

    const SEP_MAP: Record<string, string> = {
        hr: '<hr class="file-divider">',
        pagebreak: '<div class="page-break" style="page-break-after: always;"></div>',
        none: '',
    };
    const sepHtml = SEP_MAP[separator] ?? '<hr class="file-divider">';

    // Resolve includes
    const includePaths = resolveIncludes(absPrimary, frontMatter);

    // Build sectionIds map for link rewriting
    const sectionIds = new Map<string, string>();
    if (sectionAnchors) {
        for (const ip of includePaths) {
            sectionIds.set(ip, pathToSectionId(primaryDir, ip));
        }
    }

    // Process primary body
    const primaryBodyProc = rewriteMdLinks(primaryBody, absPrimary, sectionIds, sectionAnchors);
    const primaryHtml = convertMarkdownToHtml(primaryBodyProc);

    const contentBlocks: string[] = [];
    if (primaryHtml) {
        contentBlocks.push(primaryHtml);
    }

    // Process each include
    for (const incPath of includePaths) {
        const { data: incFm, body: incBody } = parseFrontMatter(incPath);
        void incFm; // used for recursive resolution only — already done above

        const incBodyProc = rewriteMdLinks(incBody, incPath, sectionIds, sectionAnchors);
        let incHtml = convertMarkdownToHtml(incBodyProc);

        if (!incHtml) {
            throw new Error(tasks.loc('IncludeConversionFailed', incPath));
        }

        if (headingShift) {
            incHtml = shiftHeadingLevels(incHtml, headingShift);
        }

        if (sepHtml && contentBlocks.length > 0) {
            contentBlocks.push(sepHtml);
        }

        const sectionId = sectionIds.get(incPath);
        if (sectionAnchors && sectionId) {
            contentBlocks.push(`<section id="${sectionId}">`);
            contentBlocks.push(incHtml);
            contentBlocks.push('</section>');
        } else {
            contentBlocks.push(incHtml);
        }
    }

    let combinedHtml = contentBlocks.join('\n');

    // Optional TOC
    if (tocEnabled && includePaths.length > 0) {
        const { toc, html: withIds } = buildToc(combinedHtml);
        combinedHtml = toc + withIds;
    }

    const htmlDocument = generateHtmlDocument([combinedHtml], title);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), htmlDocument, 'utf8');

    if (options.debug) {
        console.log(tasks.loc('FrontMatterConversionComplete', outputPath));
        console.log(tasks.loc('TitleResolved', title));
    }

    const relativeIncludes = includePaths.map((ip) => path.relative(primaryDir, ip));
    return { title, relativeIncludes };
}

/**
 * Process an explicit list of markdown files and combine into a single HTML file.
 * Ports process_files + the main() file-list path.
 */
export async function processFileList(
    inputFiles: string[],
    outputPath: string,
    options: FileListOptions & { title?: string } = {}
): Promise<void> {
    const { addSections = false, addDividers = false, debug = false, title = 'Combined Markdown Files' } = options;

    const contentBlocks: string[] = [];
    const fileTitles: Array<{ id: string; name: string }> = [];

    // Build TOC if sections enabled and multiple files
    if (inputFiles.length > 1 && addSections) {
        const toc = ['<div class="table-of-contents">', '<h2>Table of Contents</h2>', '<ul>'];
        for (let i = 0; i < inputFiles.length; i++) {
            const fileName = path.basename(inputFiles[i]);
            const fileId = `file-${i + 1}`;
            // fileId is always the safe, machine-generated `file-N`; fileName is an
            // operator/contributor-supplied filename and must be escaped -- this TOC
            // entry is never passed through sanitizeRenderedHtml (#12).
            toc.push(`<li><a href="#${fileId}">${escapeHtml(fileName)}</a></li>`);
            fileTitles.push({ id: fileId, name: fileName });
        }
        toc.push('</ul>', '</div>');
        contentBlocks.push(toc.join('\n'));
    }

    for (let i = 0; i < inputFiles.length; i++) {
        const filePath = inputFiles[i];
        const markdownContent = fs.readFileSync(filePath, 'utf8');

        if (i > 0 && addDividers) {
            contentBlocks.push('<hr class="file-divider">');
        }

        contentBlocks.push('<div class="file-section">');

        if (addSections) {
            const { id: fileId, name: fileName } = fileTitles[i] ?? { id: `file-${i + 1}`, name: path.basename(filePath) };
            // fileName is escaped for the same reason as the TOC entry above (#12).
            contentBlocks.push(`<h2 id="${fileId}" class="file-title">${escapeHtml(fileName)}</h2>`);
        }

        const htmlContent = convertMarkdownToHtml(markdownContent);
        if (!htmlContent) {
            throw new Error(tasks.loc('FileConversionFailed', filePath));
        }

        if (debug) {
            console.log(tasks.loc('FileConverted', filePath));
        }

        contentBlocks.push(htmlContent);
        contentBlocks.push('</div>');
    }

    const htmlDocument = generateHtmlDocument(contentBlocks, title);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), htmlDocument, 'utf8');
}
