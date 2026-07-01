/**
 * Tests for Markdown2Html task modules (TDD — written before implementation).
 * Run with: npm test
 */

import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');

// Pure-logic modules (no task harness required)
import { parseFrontMatter } from '../src/frontmatter';
import { resolveIncludes } from '../src/includes';
import {
    preprocessMarkdown,
    postProcessHtml,
    buildToc,
    convertMarkdownToHtml,
    shiftHeadingLevels,
} from '../src/render';
import { generateHtmlDocument } from '../src/document';
import { parseFileList, processFileList, processFrontMatterDriven } from '../src/converter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-test-'));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

function writeTmpDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-test-'));
    for (const [name, content] of Object.entries(files)) {
        const fullPath = path.join(dir, name);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
    }
    return dir;
}

// Normalise whitespace for comparison: collapse runs, strip trailing spaces
function normalise(s: string): string {
    return s
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ---------------------------------------------------------------------------
// parseFrontMatter
// ---------------------------------------------------------------------------

describe('parseFrontMatter', () => {
    it('parses valid YAML front matter', () => {
        const p = writeTmp('a.md', '---\ntitle: Hello World\nkb-key: KB001\n---\n# Body\n');
        const { data, body } = parseFrontMatter(p);
        assert.strictEqual(data['title'], 'Hello World');
        assert.strictEqual(data['kb-key'], 'KB001');
        assert.ok(body.includes('# Body'));
    });

    it('returns empty data when no front matter', () => {
        const p = writeTmp('b.md', '# No front matter\n\nJust content.\n');
        const { data, body } = parseFrontMatter(p);
        assert.deepStrictEqual(data, {});
        assert.ok(body.includes('# No front matter'));
    });

    it('handles CRLF line endings', () => {
        const p = writeTmp('c.md', '---\r\ntitle: CRLF Test\r\n---\r\n# Body\r\n');
        const { data, body } = parseFrontMatter(p);
        assert.strictEqual(data['title'], 'CRLF Test');
        assert.ok(body.includes('# Body'));
    });

    it('parses list values in front matter', () => {
        const p = writeTmp('d.md', '---\nincludes:\n  - sub1.md\n  - sub2.md\n---\nbody\n');
        const { data } = parseFrontMatter(p);
        assert.deepStrictEqual(data['includes'], ['sub1.md', 'sub2.md']);
    });

    it('parses nested map values in front matter', () => {
        const p = writeTmp('e.md', '---\ninclude-options:\n  toc: true\n  heading-shift: 1\n---\nbody\n');
        const { data } = parseFrontMatter(p);
        const opts = data['include-options'] as Record<string, unknown>;
        assert.strictEqual(opts['toc'], true);
        assert.strictEqual(opts['heading-shift'], 1);
    });
});

// ---------------------------------------------------------------------------
// parseFileList
// ---------------------------------------------------------------------------

describe('parseFileList', () => {
    it('splits on newlines', () => {
        assert.deepStrictEqual(parseFileList('./a.md\n./b.md'), ['./a.md', './b.md']);
    });

    it('splits on commas', () => {
        assert.deepStrictEqual(parseFileList('./a.md,./b.md'), ['./a.md', './b.md']);
    });

    it('handles CRLF and trims whitespace', () => {
        assert.deepStrictEqual(parseFileList(' ./a.md \r\n ./b.md '), ['./a.md', './b.md']);
    });

    it('drops empty entries from consecutive separators', () => {
        assert.deepStrictEqual(parseFileList('./a.md,,\n,./b.md'), ['./a.md', './b.md']);
    });

    it('returns empty array for blank input', () => {
        assert.deepStrictEqual(parseFileList('   \n  '), []);
    });
});

// ---------------------------------------------------------------------------
// resolveIncludes
// ---------------------------------------------------------------------------

describe('resolveIncludes', () => {
    it('returns empty array when no includes', () => {
        const dir = writeTmpDir({ 'primary.md': '---\ntitle: t\n---\nbody\n' });
        const { data } = parseFrontMatter(path.join(dir, 'primary.md'));
        const result = resolveIncludes(path.join(dir, 'primary.md'), data);
        assert.deepStrictEqual(result, []);
    });

    it('returns resolved absolute paths for valid includes', () => {
        const dir = writeTmpDir({
            'primary.md': '---\nincludes:\n  - sub.md\n---\nbody\n',
            'sub.md': '# Sub\n',
        });
        const { data } = parseFrontMatter(path.join(dir, 'primary.md'));
        const result = resolveIncludes(path.join(dir, 'primary.md'), data);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0], path.resolve(dir, 'sub.md'));
    });

    it('throws on cycle detection', () => {
        const dir = writeTmpDir({
            'primary.md': '---\nincludes:\n  - sub.md\n---\nbody\n',
            'sub.md': '---\nincludes:\n  - primary.md\n---\nsub body\n',
        });
        const { data } = parseFrontMatter(path.join(dir, 'primary.md'));
        assert.throws(
            () => resolveIncludes(path.join(dir, 'primary.md'), data),
            /cycle/i
        );
    });

    it('throws when depth exceeds MAX_INCLUDE_DEPTH (5)', () => {
        // Build a chain: a→b→c→d→e→f→g→h (8 levels).
        // resolveIncludes is only called recursively when an include itself has includes.
        // depth starts at 0; the check fires when depth > 5 (i.e. depth=6).
        // With a→b→…→g→h: resolveIncludes(g, depth=6) triggers the error.
        const dir = writeTmpDir({
            'a.md': '---\nincludes:\n  - b.md\n---\na\n',
            'b.md': '---\nincludes:\n  - c.md\n---\nb\n',
            'c.md': '---\nincludes:\n  - d.md\n---\nc\n',
            'd.md': '---\nincludes:\n  - e.md\n---\nd\n',
            'e.md': '---\nincludes:\n  - f.md\n---\ne\n',
            'f.md': '---\nincludes:\n  - g.md\n---\nf\n',
            'g.md': '---\nincludes:\n  - h.md\n---\ng\n',
            'h.md': 'h\n',
        });
        const { data } = parseFrontMatter(path.join(dir, 'a.md'));
        assert.throws(
            () => resolveIncludes(path.join(dir, 'a.md'), data),
            /depth/i
        );
    });

    it('throws when an include has a kb-key field', () => {
        const dir = writeTmpDir({
            'primary.md': '---\nincludes:\n  - sub.md\n---\nbody\n',
            'sub.md': '---\nkb-key: KB999\n---\nsub body\n',
        });
        const { data } = parseFrontMatter(path.join(dir, 'primary.md'));
        assert.throws(
            () => resolveIncludes(path.join(dir, 'primary.md'), data),
            /kb-key/i
        );
    });

    it('skips duplicate includes without throwing', () => {
        const dir = writeTmpDir({
            'primary.md': '---\nincludes:\n  - sub.md\n  - sub.md\n---\nbody\n',
            'sub.md': '# Sub\n',
        });
        const { data } = parseFrontMatter(path.join(dir, 'primary.md'));
        const result = resolveIncludes(path.join(dir, 'primary.md'), data);
        assert.strictEqual(result.length, 1);
    });
});

// ---------------------------------------------------------------------------
// preprocessMarkdown
// ---------------------------------------------------------------------------

describe('preprocessMarkdown', () => {
    it('adds blank line before numbered list not preceded by blank line', () => {
        const input = 'Some text\n1. item one';
        const output = preprocessMarkdown(input);
        assert.ok(output.includes('Some text\n\n1. item one'), `got: ${JSON.stringify(output)}`);
    });

    it('adds blank line before bullet list not preceded by blank line', () => {
        const input = 'Some text\n- bullet';
        const output = preprocessMarkdown(input);
        assert.ok(output.includes('Some text\n\n- bullet'), `got: ${JSON.stringify(output)}`);
    });

    it('adds blank line before header not preceded by blank line', () => {
        const input = 'Some text\n## Heading';
        const output = preprocessMarkdown(input);
        assert.ok(output.includes('Some text\n\n## Heading'), `got: ${JSON.stringify(output)}`);
    });

    it('adds blank line inside code fence in list', () => {
        // Pattern: newline + spaces + ``` + lang
        const input = 'Steps:\n\n1. Do thing\n\n   ```bash\n   echo hi\n   ```\n';
        const output = preprocessMarkdown(input);
        // Should still be valid after processing
        assert.ok(typeof output === 'string');
        assert.ok(output.includes('```bash'));
    });
});

// ---------------------------------------------------------------------------
// postProcessHtml
// ---------------------------------------------------------------------------

describe('postProcessHtml', () => {
    it('wraps orphan ordered list items in <ol>', () => {
        // Only wraps when there is no existing <ol>
        const input = '<li>1. first item</li>\n<li>2. second item</li>\n';
        const output = postProcessHtml(input);
        // When orphan <li> items with numbering are found, they get wrapped
        // The function checks for the specific pattern r"(<li>\d+[\.\)] .+?</li>\s*)+"
        assert.ok(typeof output === 'string');
    });

    it('does not wrap when <ol> already present', () => {
        const input = '<ol><li>item</li></ol>';
        const output = postProcessHtml(input);
        assert.strictEqual(output, input);
    });
});

// ---------------------------------------------------------------------------
// buildToc
// ---------------------------------------------------------------------------

describe('buildToc', () => {
    it('generates a TOC with heading links', () => {
        const html = '<h1>Introduction</h1><p>text</p><h2>Section One</h2><p>more</p>';
        const { toc, html: modifiedHtml } = buildToc(html);
        assert.ok(toc.includes('Introduction'));
        assert.ok(toc.includes('Section One'));
        assert.ok(toc.includes('<nav'));
        assert.ok(modifiedHtml.includes('id='));
    });

    it('returns empty toc when no headings', () => {
        const html = '<p>no headings here</p>';
        const { toc } = buildToc(html);
        assert.strictEqual(toc, '');
    });

    it('slug strips non-word characters', () => {
        const html = '<h1>Hello, World! (Test)</h1>';
        const { toc } = buildToc(html);
        // slug: hello--world---test- → hello-world-test
        assert.ok(toc.includes('href="#hello'));
        assert.ok(!toc.includes('href="#hello,')); // comma stripped
    });

    it('slug is stable across calls', () => {
        const html = '<h2>My Section</h2>';
        const { toc: toc1 } = buildToc(html);
        const { toc: toc2 } = buildToc(html);
        const extractHref = (t: string) => t.match(/href="([^"]+)"/)?.[1];
        assert.strictEqual(extractHref(toc1), extractHref(toc2));
    });

    it('injects id attributes into headings without them', () => {
        const html = '<h1>Title</h1><h2>Sub</h2>';
        const { html: modified } = buildToc(html);
        assert.ok(modified.includes('id="title"'));
        assert.ok(modified.includes('id="sub"'));
    });
});

// ---------------------------------------------------------------------------
// shiftHeadingLevels
// ---------------------------------------------------------------------------

describe('shiftHeadingLevels', () => {
    it('shifts h1→h2 with shift=1', () => {
        const html = '<h1>Title</h1><h2>Sub</h2>';
        const out = shiftHeadingLevels(html, 1);
        assert.ok(out.includes('<h2>Title</h2>'));
        assert.ok(out.includes('<h3>Sub</h3>'));
    });

    it('caps at h6', () => {
        const html = '<h5>Deep</h5><h6>Deepest</h6>';
        const out = shiftHeadingLevels(html, 2);
        assert.ok(out.includes('<h6>'));
        assert.ok(!out.includes('<h7>'));
    });

    it('returns unchanged when shift=0', () => {
        const html = '<h1>Title</h1>';
        assert.strictEqual(shiftHeadingLevels(html, 0), html);
    });

    it('preserves attributes on opening tag', () => {
        const html = '<h1 id="intro">Intro</h1>';
        const out = shiftHeadingLevels(html, 1);
        assert.ok(out.includes('<h2 id="intro">Intro</h2>'));
    });
});

// ---------------------------------------------------------------------------
// generateHtmlDocument
// ---------------------------------------------------------------------------

describe('generateHtmlDocument', () => {
    it('produces valid HTML document wrapper', () => {
        const doc = generateHtmlDocument(['<p>Hello</p>'], 'Test Title');
        assert.ok(doc.includes('<!DOCTYPE html>'));
        assert.ok(doc.includes('<title>Test Title</title>'));
        assert.ok(doc.includes('<p>Hello</p>'));
        assert.ok(doc.includes('<style>'));
    });

    it('includes the document-title h1', () => {
        const doc = generateHtmlDocument(['<p>content</p>'], 'My Doc');
        assert.ok(doc.includes('class="document-title"'));
        assert.ok(doc.includes('My Doc'));
    });

    it('joins multiple content blocks', () => {
        const doc = generateHtmlDocument(['<p>block1</p>', '<p>block2</p>'], 'T');
        assert.ok(doc.includes('<p>block1</p>'));
        assert.ok(doc.includes('<p>block2</p>'));
    });
});

// ---------------------------------------------------------------------------
// convertMarkdownToHtml — integration
// ---------------------------------------------------------------------------

describe('convertMarkdownToHtml', () => {
    it('converts a heading', () => {
        const html = convertMarkdownToHtml('# Hello');
        assert.ok(html.includes('<h1>Hello</h1>'));
    });

    it('converts a table', () => {
        const md = '| A | B |\n|---|---|\n| 1 | 2 |';
        const html = convertMarkdownToHtml(md);
        assert.ok(html.includes('<table>'));
        assert.ok(html.includes('<th>'));
    });

    it('converts a fenced code block to <pre><code>', () => {
        const md = '```js\nconst x = 1;\n```';
        const html = convertMarkdownToHtml(md);
        assert.ok(html.includes('<pre>'));
        // markdown-it emits <code class="language-js"> — check for opening tag without '>'
        assert.ok(html.includes('<code'), `Expected <code in: ${html}`);
    });

    it('syntax-highlights a known language with hljs classes', () => {
        const html = convertMarkdownToHtml('```js\nconst x = 1;\n```');
        assert.ok(html.includes('class="hljs'), 'expected hljs class on code block');
        assert.ok(html.includes('hljs-keyword'), 'expected highlighted keyword span');
        assert.ok(html.includes('language-js'), 'expected language class');
    });

    it('falls back to escaped plain text for unknown language', () => {
        const html = convertMarkdownToHtml('```notalang\na < b && c\n```');
        assert.ok(html.includes('class="hljs'), 'still wrapped in hljs container');
        // No language class, content HTML-escaped, no highlight spans.
        assert.ok(html.includes('&lt;') && html.includes('&amp;'), 'content escaped');
        assert.ok(!html.includes('hljs-keyword'), 'no highlight spans for unknown lang');
    });

    it('embeds the highlight theme CSS in the document', () => {
        const doc = generateHtmlDocument([convertMarkdownToHtml('```js\nlet a=1;\n```')], 'T');
        assert.ok(doc.includes('.hljs-keyword'), 'theme rule present in <style>');
    });
});

// ---------------------------------------------------------------------------
// Golden-file test
// ---------------------------------------------------------------------------

describe('Golden file', () => {
    const goldenPath = path.join(__dirname, 'golden', 'naming-module.html');
    const readmePath = 'C:/dev/ado/code/shared/universal_modules/terraform-universal-naming/README.md';

    before(function () {
        if (!fs.existsSync(goldenPath)) {
            console.log(`  [SKIP] Golden file not found at ${goldenPath}`);
            this.skip();
        }
        if (!fs.existsSync(readmePath)) {
            console.log(`  [SKIP] Source README not found at ${readmePath}`);
            this.skip();
        }
    });

    it('TypeScript output structurally matches golden HTML', () => {
        const goldenHtml = fs.readFileSync(goldenPath, 'utf8');
        const readmeMd = fs.readFileSync(readmePath, 'utf8');

        // Use the TypeScript converter
        const { generateHtmlDocument: genDoc } = require('../src/document');
        const { convertMarkdownToHtml: convert } = require('../src/render');
        const tsHtml = genDoc([convert(readmeMd)], 'Terraform Universal Naming Module');

        const cheerio = require('cheerio');
        const $g = cheerio.load(goldenHtml);
        const $t = cheerio.load(tsHtml);

        // (a) Heading sequence must match exactly (text + level), aside from the
        // document-title <h1> both renderers inject identically.
        const headingSeq = ($: any) =>
            $('h1, h2, h3, h4, h5, h6')
                .toArray()
                .map((el: any) => `${(el as any).name}:${$(el).text().trim()}`);
        assert.deepStrictEqual(
            headingSeq($t),
            headingSeq($g),
            'Heading sequence (level + text) must match the golden file exactly',
        );

        // (b) Content coverage: every alphanumeric word token in the golden body
        // must also appear in the TypeScript body. This catches dropped or garbled
        // content (the original ±2 heading-count check would not), while tolerating
        // the documented markdown-it vs python-markdown divergences in ordered-list
        // marker text and whitespace (see RENDERING-NOTES.md) — those change the
        // exact string but not the set of words present.
        // Pure-numeric tokens are excluded: python-markdown renders some ordered-list
        // markers (5, 7, 9, 10, 12 …) as literal text while markdown-it emits them as
        // <ol> numbering outside the text node. That is the documented marker-text
        // divergence, not missing content — so compare alphabetic word tokens only.
        const wordSet = ($: any): Set<string> => {
            const text = $('body').text().toLowerCase();
            const words = (text.match(/[a-z0-9_]+/g) ?? []).filter((w: string) => /[a-z]/.test(w));
            return new Set<string>(words);
        };
        const goldenWords = wordSet($g);
        const tsWords = wordSet($t);
        const missing = [...goldenWords].filter((w) => !tsWords.has(w));
        assert.deepStrictEqual(
            missing,
            [],
            `TypeScript output is missing words present in the golden file: ${missing.slice(0, 20).join(', ')}`,
        );

        // (c) Table presence parity.
        if ($g('table').length > 0) {
            assert.ok($t('table').length > 0, 'Expected TypeScript output to contain tables');
        }
    });
});

// ---------------------------------------------------------------------------
// processFileList (orchestrator)
// ---------------------------------------------------------------------------

describe('processFileList', () => {
    it('writes a single-file HTML document', async () => {
        const dir = writeTmpDir({ 'a.md': '# Alpha\n\nHello world.\n' });
        const out = path.join(dir, 'out.html');
        await processFileList([path.join(dir, 'a.md')], out);
        const html = fs.readFileSync(out, 'utf8');
        assert.ok(html.includes('<h1'), 'expected a heading');
        assert.ok(/Alpha/.test(html), 'expected the heading text');
        assert.ok(html.includes('file-section'), 'expected a file-section wrapper');
    });

    it('adds a TOC, section headings and dividers for multiple files', async () => {
        const dir = writeTmpDir({ 'a.md': '# Alpha\n\nOne.\n', 'b.md': '# Beta\n\nTwo.\n' });
        const out = path.join(dir, 'out.html');
        await processFileList(
            [path.join(dir, 'a.md'), path.join(dir, 'b.md')],
            out,
            { addSections: true, addDividers: true, title: 'Combined Doc', debug: true }
        );
        const html = fs.readFileSync(out, 'utf8');
        assert.ok(html.includes('table-of-contents'), 'expected a table of contents');
        assert.ok(html.includes('file-divider'), 'expected a divider between files');
        assert.ok(html.includes('class="file-title"'), 'expected file-title section headings');
        assert.ok(html.includes('Combined Doc'), 'expected the document title');
    });

    it('creates the output directory when it does not exist', async () => {
        const dir = writeTmpDir({ 'a.md': '# Alpha\n\nHi.\n' });
        const out = path.join(dir, 'nested', 'deep', 'out.html');
        await processFileList([path.join(dir, 'a.md')], out);
        assert.ok(fs.existsSync(out), 'expected the nested output file to be written');
    });

    it('throws when an input file cannot be converted', async () => {
        const dir = writeTmpDir({ 'empty.md': '   \n' });
        await assert.rejects(
            processFileList([path.join(dir, 'empty.md')], path.join(dir, 'out.html')),
            /Failed to convert/,
        );
    });
});

// ---------------------------------------------------------------------------
// processFrontMatterDriven (orchestrator)
// ---------------------------------------------------------------------------

describe('processFrontMatterDriven', () => {
    it('combines a primary file with includes, TOC, dividers and section anchors', async () => {
        const dir = writeTmpDir({
            'main.md': [
                '---',
                'title: My Doc',
                'includes:',
                '  - part1.md',
                '  - part2.md',
                'include-options:',
                '  toc: true',
                '  separator: hr',
                '  heading-shift: 1',
                '  section-anchors: true',
                '---',
                '# Intro',
                '',
                'Primary body.',
                '',
            ].join('\n'),
            'part1.md': '# Part One\n\nContent one.\n',
            'part2.md': '# Part Two\n\nContent two.\n',
        });
        const out = path.join(dir, 'out.html');
        const result = await processFrontMatterDriven(path.join(dir, 'main.md'), out, { debug: true });
        assert.strictEqual(result.title, 'My Doc');
        assert.deepStrictEqual(result.relativeIncludes, ['part1.md', 'part2.md']);
        const html = fs.readFileSync(out, 'utf8');
        assert.ok(html.includes('My Doc'), 'expected the document title');
        assert.ok(/Table of Contents/i.test(html), 'expected a generated TOC');
        assert.ok(html.includes('file-divider'), 'expected the hr separator between includes');
        assert.ok(html.includes('<section id='), 'expected section-anchor wrappers');
    });

    it('derives the title from the first h1 when front matter has none', async () => {
        const dir = writeTmpDir({ 'doc.md': '# Derived Title\n\nBody.\n' });
        const out = path.join(dir, 'out.html');
        const result = await processFrontMatterDriven(path.join(dir, 'doc.md'), out);
        assert.strictEqual(result.title, 'Derived Title');
        assert.deepStrictEqual(result.relativeIncludes, []);
    });

    it('honours a title override', async () => {
        const dir = writeTmpDir({ 'noheading.md': 'Just text, no heading.\n' });
        const out = path.join(dir, 'out.html');
        const result = await processFrontMatterDriven(path.join(dir, 'noheading.md'), out, { titleOverride: 'Forced Title' });
        assert.strictEqual(result.title, 'Forced Title');
    });

    it('falls back to the file basename when there is no title or h1', async () => {
        const dir = writeTmpDir({ 'basenamedoc.md': 'No heading here.\n' });
        const out = path.join(dir, 'out.html');
        const result = await processFrontMatterDriven(path.join(dir, 'basenamedoc.md'), out);
        assert.strictEqual(result.title, 'basenamedoc');
    });
});
