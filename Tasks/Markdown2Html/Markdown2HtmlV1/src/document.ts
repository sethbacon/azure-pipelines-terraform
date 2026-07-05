/**
 * HTML document generator.
 * Ports generate_html_document from md2html_converter.py.
 * CSS block is copied verbatim from the Python source so existing articles render identically.
 */

import { HIGHLIGHT_THEME_CSS } from './highlight-theme';

/**
 * HTML-escape a value interpolated into element text context. The document
 * title comes from front matter or the first H1 of author markdown; without
 * escaping, a title such as `</title><script>…` would break out of the <title>
 * and <h1> elements and inject markup into the published KB article.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Generate a complete HTML document from content blocks.
 * CSS is copied verbatim from the Python original, plus the highlight.js theme
 * for syntax-highlighted code blocks.
 */
export function generateHtmlDocument(
    contentBlocks: string[],
    title: string = 'Combined Markdown Files'
): string {
    const combinedContent = contentBlocks.join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            padding: 20px;
            max-width: 800px;
            margin: 0 auto;
        }
        pre {
            background-color: #f6f8fa;
            border-radius: 3px;
            padding: 16px;
            overflow: auto;
        }
        code {
            font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
            background-color: rgba(27, 31, 35, 0.05);
            border-radius: 3px;
            padding: 0.2em 0.4em;
        }
        pre code {
            background-color: transparent;
            padding: 0;
        }
        blockquote {
            border-left: 4px solid #ddd;
            padding-left: 16px;
            color: #666;
            margin-left: 0;
        }
        img {
            max-width: 100%;
        }
        table {
            border-collapse: collapse;
            width: 100%;
        }
        table, th, td {
            border: 1px solid #ddd;
        }
        th, td {
            padding: 8px;
            text-align: left;
        }
        th {
            background-color: #f2f2f2;
        }
        .file-divider {
            border: 0;
            height: 1px;
            background-image: linear-gradient(to right, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0));
            margin: 30px 0;
        }
        .file-title {
            color: #0366d6;
            padding-bottom: 10px;
            border-bottom: 1px solid #eaecef;
            margin-top: 30px;
        }
        .table-of-contents {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 30px;
        }
        .table-of-contents ul {
            padding-left: 20px;
        }
        .file-section {
            margin-bottom: 40px;
        }
        /* Add a document title at the top of the page */
        .document-title {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 2px solid #0366d6;
        }
        /* Proper list styling */
        ol {
            list-style-type: decimal;
            padding-left: 30px;
        }
        ul {
            list-style-type: disc;
            padding-left: 30px;
        }
        li {
            margin-bottom: 5px;
        }
        li > ol, li > ul {
            margin-top: 5px;
            margin-bottom: 10px;
        }
        /* highlight.js theme (GitHub light) for fenced code blocks */
        ${HIGHLIGHT_THEME_CSS}
    </style>
</head>
<body>
<h1 class="document-title">${escapeHtml(title)}</h1>
${combinedContent}
</body>
</html>`;
}
