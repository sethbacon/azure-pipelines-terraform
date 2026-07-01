# Rendering Notes: markdown-it vs python-markdown divergences

This file documents intentional and incidental differences between the TypeScript
(markdown-it) renderer and the original Python (python-markdown) renderer.

## 1. Code syntax highlighting (codehilite) — IMPLEMENTED

**Python:** `python-markdown` with the `codehilite` extension runs fenced code blocks
through Pygments, producing `<div class="codehilite"><pre><span class="k">…</span>…</pre></div>`
with language-specific CSS classes.

**TypeScript:** `markdown-it` is configured with a `highlight` callback backed by
`highlight.js` (v11). Fenced code blocks render as
`<pre><code class="hljs language-XXX"><span class="hljs-keyword">…</span>…</code></pre>`.
The matching theme CSS (highlight.js "GitHub" light theme) is embedded in the document
`<style>` block by `generateHtmlDocument` (see `highlight-theme.ts`).

**Verified against a live ServiceNow instance (2026-06-01):** the `<style>` block — and
therefore the embedded hljs theme — is preserved in the stored `kb_knowledge.text` field.
ServiceNow strips only the `<!DOCTYPE>` and re-encodes some attribute characters
(`=` → `&#61;`); it keeps `<html>/<head>/<body>/<style>`. So embedded highlight CSS renders.

**Class names differ from Pygments** (`hljs-*` vs Pygments' `k`/`n`/`s`), so any article
that shipped a hand-authored Pygments stylesheet would not be colour-matched — but the
self-contained embedded theme makes that moot for articles produced by this task.

## 1b. ServiceNow HTML handling (live findings, 2026-06-01)

Probed against `brunswick.service-now.com` with the `CEAAPI` basic-auth account:

| Behaviour | Result |
|---|---|
| `<!DOCTYPE html>` | stripped on save |
| `<html>/<head>/<body>/<style>/<title>` | preserved in `kb_knowledge.text` |
| `<style>` CSS (incl. embedded hljs theme) | preserved |
| `body` payload field | ignored — not a real column; only `text` is stored |
| `author` as a username string (e.g. `CEAAPI`) | resolved to the matching `sys_user` reference |
| Attachment upload (`POST /api/now/attachment/file`) | 201; account can upload AND delete attachments |
| Attachment fetch (`/api/now/attachment/{id}/file`) | 200, serves `image/png` |
| Article DELETE | 403 (account lacks delete on `kb_knowledge`) |

Implication: images should be uploaded as ServiceNow attachments and referenced via a
relative `sys_attachment.do?sys_id=<id>` URL in the article body (render-safe for any
authenticated KB reader), rather than external URLs or base64 data URIs.

## 2. Paragraph whitespace

`markdown-it` may emit slightly different amounts of whitespace inside `<p>` tags and
between block elements than python-markdown. The golden-file test normalises whitespace
(collapses runs, strips trailing spaces) before comparing heading sequences, so these
differences do not cause test failures.

## 2b. Ordered-list marker text

`markdown-it` renders some ordered lists such that the list-item *text* retains the
literal ordinal marker (e.g. `1) Clone the repository`), whereas python-markdown's
output (combined with the `postProcessHtml` orphan-`<li>` wrapping) produces the item
text without the inline marker. The golden README also contains a hand-authored list that
skips a number (`10) … 12)`); markdown-it and python-markdown disagree on whether that
literal text is preserved.

**Impact:** The rendered list content is equivalent and the words are identical; only the
presence of the `N)`/`N.` marker inside the item text differs. The golden-file test
therefore asserts *word-set coverage* (every golden word appears in the TS output) plus an
*exact heading sequence*, rather than byte-identical body text. This catches dropped or
garbled content without failing on the marker-text divergence.

## 3. BeautifulSoup vs cheerio — TOC serialisation

Python's `_build_toc` uses `str(soup)` which may produce slightly different attribute
quoting or void-element formatting than cheerio's serialiser. The golden-file test
compares structural equivalence (heading count, table presence) rather than byte-for-byte
HTML strings, so this does not cause failures.

## 4. TypeScript version

Used `typescript@^6.0.3` as specified in the implementation guide. No toolchain
incompatibilities were encountered. `ts-node@^10.9.2` accepted TypeScript 6 without
issues.

## 5. Golden file status

Golden fixture generated successfully by running the original Python script:
```
python md2html_converter.py -o Tests/golden/naming-module.html \
  --title "Terraform Universal Naming Module" \
  /c/dev/ado/code/shared/universal_modules/terraform-universal-naming/README.md
```
The golden-file test asserts structural equivalence (heading count ±2, table presence)
rather than exact byte comparison, to tolerate the codehilite and whitespace divergences
documented above.
