/**
 * Class test (issues #884/#897): an attacker-influenceable string used as a
 * key into a plain object literal resolves __proto__/constructor/toString/
 * valueOf/hasOwnProperty to an INHERITED Object.prototype member instead of
 * falling through to the not-found branch. This file covers converter.ts's
 * SEP_MAP, keyed by the front-matter `include-options.separator` value.
 */
import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
import { processFrontMatterDriven } from '../src/converter';

function writeTmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2html-proto-'));
  for (const [name, content] of Object.entries(files)) {
    const fullPath = path.join(dir, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
  return dir;
}

async function renderWithSeparator(separator: string): Promise<string> {
  const dir = writeTmpDir({
    'main.md': [
      '---',
      'includes:',
      '  - part1.md',
      'include-options:',
      `  separator: ${separator}`,
      '---',
      '# Intro',
      '',
    ].join('\n'),
    'part1.md': '# Part One\n\nContent one.\n',
  });
  const out = path.join(dir, 'out.html');
  await processFrontMatterDriven(path.join(dir, 'main.md'), out);
  return fs.readFileSync(out, 'utf8');
}

// The document template's <style> block unconditionally defines a
// `.file-divider { ... }` CSS rule regardless of whether any divider is
// actually used in the body, so assertions below check for the MARKUP tag
// (as SEP_MAP actually emits it), not the bare class-name substring, which
// the CSS rule alone would satisfy even when no divider was rendered.
const HR_DIVIDER_MARKUP = '<hr class="file-divider">';
const PAGEBREAK_DIVIDER_MARKUP = '<div class="page-break"';

describe('converter: SEP_MAP separator lookup (prototype-pollution class)', () => {
  it("renders the 'hr' divider between includes", async () => {
    const html = await renderWithSeparator('hr');
    assert.ok(html.includes(HR_DIVIDER_MARKUP), `expected the hr divider in: ${html}`);
  });

  it("renders the 'pagebreak' divider between includes", async () => {
    const html = await renderWithSeparator('pagebreak');
    assert.ok(html.includes(PAGEBREAK_DIVIDER_MARKUP), `expected the pagebreak divider in: ${html}`);
  });

  it("renders no divider for the legitimate 'none' separator", async () => {
    const html = await renderWithSeparator('none');
    assert.ok(
      !html.includes(HR_DIVIDER_MARKUP) && !html.includes(PAGEBREAK_DIVIDER_MARKUP),
      `expected no divider markup in: ${html}`,
    );
  });

  const prototypePollutionSeparators = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  for (const separator of prototypePollutionSeparators) {
    it(`falls back to the default hr divider for separator '${separator}' (an Object.prototype member, not a real option) instead of leaking it into the document`, async () => {
      const html = await renderWithSeparator(separator);
      assert.ok(html.includes(HR_DIVIDER_MARKUP), `expected the default hr divider, not a dropped/leaked prototype member, in: ${html}`);
      assert.ok(!html.includes('[object Object]'), `must not leak '[object Object]' into the document: ${html}`);
      assert.ok(!/native code/.test(html), `must not leak a function's source into the document: ${html}`);
    });
  }
});
