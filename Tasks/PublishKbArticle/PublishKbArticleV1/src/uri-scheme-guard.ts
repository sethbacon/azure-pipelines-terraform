/**
 * Shared URI-scheme validation for the two independent HTML sanitizer/gate
 * implementations that guard the ServiceNow KB-publishing pipeline:
 * Markdown2Html's render-time `sanitizeRenderedHtml()` (defense-in-depth,
 * strips dangerous markup) and PublishKbArticle's `validateHtmlContent()`
 * (the downstream fail-closed gate, throws). Kept byte-identical across both
 * tasks' `src/` directories and guarded by scripts/check-shared-modules.js --
 * a fix to the allowlist here must never be applied to one copy and silently
 * missed in the other, which is exactly how the original control-character
 * scheme bypass (#446) evaded both layers using two independently-drifting
 * copies of this exact logic.
 */

/** Attribute names that can carry a URI capable of triggering navigation or resource loading. */
export const URI_BEARING_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'formaction', 'action']);

/**
 * Element (tag) names rejected outright by both layers: <script>/<iframe>/
 * <object>/<embed>/<noscript> are executable/embedding elements with no
 * legitimate use in a KB article fragment; <form> likewise has none, and an
 * action="javascript:..." attribute is otherwise a blocklist-fragile
 * per-attribute check (#446 follow-up); the SVG SMIL animation elements
 * (animate/animateColor/animateTransform/animateMotion/set) can dynamically
 * assign a javascript: URI into a referenced attribute (e.g. an <a>'s href)
 * at RUNTIME via their to/from/values attributes, a vector the static
 * attribute-value scan above cannot catch. Lower-cased tag names -- match by
 * comparing a lower-cased tagName, NOT a CSS tag selector: per the HTML5
 * foreign-content parsing algorithm, cheerio/parse5 preserves the SVG spec's
 * camelCase spelling for animateColor/animateTransform/animateMotion (unlike
 * ordinary HTML tags, which are lower-cased), and a css-select tag selector
 * does not match these foreign-namespaced nodes by name in either case
 * (verified empirically). Before this set covered iframe/object/embed/
 * noscript, PublishKbArticle's validateHtmlContent() gate never rejected them
 * at all -- only Markdown2Html's render-time sanitizer stripped them -- so
 * HTML supplied directly via the htmlFile input (bypassing Markdown2Html
 * entirely) could carry a live <iframe srcdoc="..."> or <object data="...">
 * straight past the fail-closed gate.
 *
 * `link` joins this set for #523: it has no legitimate use in either
 * consumer's input (Markdown2Html's generated document never emits one), and
 * a `<link rel="stylesheet" href="...">` is a CSS-injection/exfiltration
 * vector (attribute-selector-driven `background: url(...)` requests can leak
 * page content byte-by-byte) regardless of URI scheme -- the existing
 * URI_BEARING_ATTRIBUTES scheme check does not cover it, since it only flags
 * javascript:/vbscript:/data: schemes, not an ordinary-looking https:// URL.
 *
 * The MathML elements (`math`, `annotation-xml`, `mglyph`, `malignmark`) and
 * SVG's `foreignObject` join the set for the mutation-XSS (mXSS) class of
 * bypass (#552): they switch the parser between the HTML/SVG/MathML
 * namespaces mid-document, and content that round-trips through a
 * parse-serialize-reparse cycle (this pipeline sanitizes and serializes; the
 * ServiceNow KB reader's browser later re-parses) can mutate across those
 * namespace boundaries into live markup neither layer saw in its own parsed
 * form -- `<annotation-xml encoding="text/html">` is the canonical carrier.
 * None of these elements has any legitimate use in a KB article (`svg` itself
 * stays allowed for inline diagrams; its per-attribute checks and the SMIL
 * removals above still apply), so they are dropped/rejected outright rather
 * than content-inspected. Like the SMIL elements, `foreignObject` keeps the
 * SVG spec's camelCase spelling in the parsed tree; the lower-cased-tagName
 * comparison both layers use matches it regardless.
 *
 * `style` is deliberately NOT in this shared set, unlike every other #523
 * candidate: Markdown2Html's generateHtmlDocument() unconditionally injects
 * its own `<head><style>...</style></head>` into every document it produces,
 * ServiceNow is verified to preserve and render that block (see
 * Markdown2Html/src/highlight-theme.ts), and the documented Markdown2Html ->
 * PublishKbArticle pipeline feeds that WHOLE generated document (head, style
 * and all) into PublishKbArticleV1's `htmlFile` input, which
 * validateHtmlContent() reads verbatim. Adding `style` here would make
 * PublishKbArticle's gate reject its own upstream task's output on every
 * run. A location-based split (allow `<style>` inside `<head>`, reject
 * elsewhere) was also considered and rejected: a raw htmlFile input that
 * bypasses Markdown2Html entirely can trivially wrap a hostile `<style>` in
 * its own `<head>`, defeating a location-based check outright. Each consumer
 * instead applies its own narrower `<style>` handling, scoped to what is
 * actually safe for its own input shape -- see sanitizeRenderedHtml() in
 * Markdown2Html's render.ts (strips any `<style>` from the body-only content
 * it sanitizes, before the trusted document wrapper is applied -- no
 * location ambiguity there) and validateHtmlContent() in PublishKbArticle's
 * html-validate.ts (rejects `<style>` CONTENT containing a network-fetching
 * CSS construct, e.g. `url(...)`/`@import`, regardless of where the element
 * sits -- Markdown2Html's own generated CSS is a fixed string with neither,
 * verified).
 */
export const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'noscript', 'form', 'link', 'animate', 'animatecolor', 'animatetransform', 'animatemotion', 'set', 'math', 'annotation-xml', 'mglyph', 'malignmark', 'foreignobject']);

/**
 * CSS constructs that can fetch a network resource or execute script from within
 * a stylesheet or an inline `style` attribute: a `url(...)` reference
 * (background-image, @import, @font-face src, list-style-image, cursor, … all
 * ultimately need one to fetch anything), `@import`, IE `expression(...)`,
 * `-moz-binding`, and `behavior:`. Any one of these in author-supplied CSS is a
 * CSS-injection/exfiltration primitive (e.g. an attribute-selector-driven
 * `background: url(...)` that leaks page content byte-by-byte) even when the URL
 * uses an ordinary https:// scheme that the URI_BEARING_ATTRIBUTES check never
 * flags.
 *
 * Unlike the `<style>` ELEMENT — which each consumer handles differently (see
 * the DANGEROUS_TAGS note above: Markdown2Html strips every `<style>` from the
 * body content it sanitizes, while PublishKbArticle must allow its upstream
 * task's own trusted `<head><style>` document wrapper and so inspects the
 * element's CONTENT with this pattern instead) — the inline `style` ATTRIBUTE
 * has no legitimate `url(...)`/`@import` use in either consumer's input, so both
 * the render-time sanitizer (removes the attribute) and the fail-closed gate
 * (throws) apply this identical check to it. That shared behavior is why the
 * pattern lives in this byte-identity-gated module rather than being hand-copied
 * into each. The `i` flag makes it case-insensitive; it carries no `g` flag, so
 * `.test()` is stateless and safe to call across many elements/attributes.
 *
 * IMPORTANT: this raw-text blocklist must NOT be matched against the author's
 * bytes directly, nor against a single "normalized" string — it is wrapped by
 * cssHasDangerousConstruct(), which mirrors the CSS tokenizer's ordering
 * (comments are lexed BEFORE escapes are processed) and tests the blocklist
 * against BOTH the comment-stripped raw text AND its escape-decoded form,
 * blocking if either matches. A single normalized string cannot express that,
 * and collapsing to one forced a decode/strip order — decode-then-strip was
 * itself a bypass (#587 follow-up). See cssHasDangerousConstruct().
 */
export const DANGEROUS_CSS_PATTERN = /url\s*\(|@import|expression\s*\(|-moz-binding|behaviou?r\s*:/i;

/**
 * Strip CSS comments the way a browser's CSS tokenizer does, as the FIRST step —
 * before any escape decoding. A real CSS comment is discarded by the lexer and
 * acts only as a token separator, so `url` and its `(` split by a comment
 * collapse back to `url(` here and cannot be used to break up a blocked token.
 * Comments are stripped from the RAW author bytes, NEVER after escape decoding:
 * the lexer forms a comment only from literal delimiter characters, so an
 * ESCAPED `\2f\2a` is two decoded code points inside a token, not a comment, and
 * must never be allowed to masquerade as one. (Stripping after decoding was
 * itself the bypass this fix closes: it let `\2f\2a url(evil) \2a\2f` decode into
 * comment delimiters wrapping a live `url(evil)`, then deleted that whole span —
 * erasing a fetch a real browser, which sees no comment there, performs.)
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Decode CSS escape sequences per CSS Syntax Level 3 §4.3.7 "consume an escaped
 * code point": a backslash plus 1–6 hex digits is that code point, with a single
 * trailing whitespace consumed as the digit-run delimiter (NUL / surrogate /
 * out-of-range maps to U+FFFD); a backslash plus any other non-newline code
 * point is that literal character; a backslash before a newline or at
 * end-of-input is not a valid escape and contributes nothing that can complete a
 * blocked token. This decodes `\75rl(...)` to `url(...)`, `@\69mport` to
 * `@import`, and the literal-char escape form `\u\r\l(...)` to `url(...)`. It
 * does NOT touch comments — comment stripping already ran on the raw bytes (see
 * cssHasDangerousConstruct); decoding must never itself produce a comment that is
 * then deleted, or an escaped delimiter pair could erase a live token.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(
    /\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f])/g,
    (_m, hex: string | undefined, literal: string | undefined): string => {
      if (hex !== undefined) {
        let cp = parseInt(hex, 16);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          cp = 0xfffd;
        }
        return String.fromCodePoint(cp);
      }
      return literal ?? '';
    },
  );
}

/**
 * True if author-supplied CSS (a `<style>` element's text or an inline `style`
 * attribute) contains a network-fetching / script-executing construct
 * (DANGEROUS_CSS_PATTERN) a browser would act on. The check mirrors the CSS
 * tokenizer's ordering — comments lexed BEFORE escapes are processed — and tests
 * the blocklist against BOTH forms, blocking if EITHER matches:
 *   (a) the raw text with real CSS comments stripped — catches a literal
 *       `url(...)`/`@import`, and a token split by a real comment (`url` + `(`);
 *   (b) the escape-decoded form of that SAME comment-stripped text, with NO
 *       further comment stripping — catches `\75rl(...)`, `@\69mport`,
 *       `u\72l(...)`, while ensuring an escaped `\2f\2a ... \2a\2f` cannot decode
 *       into a comment that deletes the live token between the delimiters.
 *
 * Decoding in (b) rather than rejecting every backslash keeps legitimate escaped
 * CSS a hand-authored `htmlFile` may carry — `content:"\201C"` smart quotes, an
 * icon-font `content:"\f001"` — from being false-flagged: those decode to
 * ordinary characters that match nothing in the blocklist.
 *
 * This two-pass predicate replaces a single decode-then-strip "normalize" helper:
 * collapsing to one normalized string had to choose a decode/strip order, and
 * decode-then-strip let the escaped-comment span above erase its own payload
 * before the blocklist ever saw it (#587 follow-up).
 */
export function cssHasDangerousConstruct(css: string): boolean {
  const commentStripped = stripCssComments(css);
  if (DANGEROUS_CSS_PATTERN.test(commentStripped)) {
    return true;
  }
  return DANGEROUS_CSS_PATTERN.test(decodeCssEscapes(commentStripped));
}

/**
 * Normalizes an attribute value before a URI-scheme check. Browsers (per the
 * WHATWG URL spec) strip ASCII tab/newline/CR before parsing a URL's scheme,
 * so a naive `value.trim().toLowerCase().startsWith('javascript:')` check can
 * be bypassed with an HTML-entity-encoded control char INSIDE the scheme (e.g.
 * `jav&#9;ascript:`) — `.trim()` only removes leading/trailing whitespace, so
 * the interior tab survives the check but is stripped by the browser at parse
 * time, yielding a working `javascript:` URI. Stripping every ASCII control
 * character (U+0000–U+001F, U+007F) from anywhere in the string — not just
 * the edges — before lower-casing closes this bypass.
 */
export function normalizeUriForSchemeCheck(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().toLowerCase();
}

/**
 * True if a NORMALIZED (see normalizeUriForSchemeCheck) attribute value uses a
 * scheme that can execute script or load arbitrary non-image content:
 * `javascript:`, `vbscript:`, or a `data:` URI other than a plain raster
 * image. `data:image/svg+xml` is deliberately EXCLUDED from the safe set even
 * though it matches the `data:image/` prefix: an SVG document can embed
 * `<script>`/event-handler attributes that execute when referenced in a
 * context other than a plain `<img>` (e.g. `<object>`, `<embed>`, or a direct
 * navigation via `<a href>`), unlike a raster format.
 */
export function isDangerousUriScheme(normalizedValue: string): boolean {
  if (normalizedValue.startsWith('javascript:') || normalizedValue.startsWith('vbscript:')) {
    return true;
  }
  if (!normalizedValue.startsWith('data:')) {
    return false;
  }
  return !(normalizedValue.startsWith('data:image/') && !normalizedValue.startsWith('data:image/svg+xml'));
}

/**
 * Extracts the redirect target from a NORMALIZED (see normalizeUriForSchemeCheck)
 * `<meta http-equiv="refresh">` `content` value, mirroring the WHATWG "shared
 * declarative refresh steps": leading ASCII digits (plus any trailing digit/dot
 * run) are the reload time and are skipped, then a `;`/`,`/whitespace separator,
 * then an OPTIONAL case-insensitive `url` token (loose whitespace around it and
 * the `=`) precedes the target. If that token isn't there, or doesn't fully
 * match, a real browser falls back to treating the WHOLE remainder as the
 * target verbatim -- so a naive `includes('url=')` requirement would miss a
 * real, working `content="0;https://evil.example/"` redirect that never spells
 * "url=" at all. A quoted target ends at its own matching quote (or runs to the
 * end of the string if unclosed); anything after that is discarded, same as the
 * browser parser. Returns `undefined` when there is no separator/target at all
 * -- a bare `content="5"` is just a timed reload of the current document, not a
 * redirect.
 */
function extractMetaRefreshTarget(input: string): string | undefined {
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
  const len = input.length;
  let pos = 0;

  while (pos < len && isSpace(input[pos])) { pos++; }

  const digitsStart = pos;
  while (pos < len && isDigit(input[pos])) { pos++; }
  if (pos === digitsStart && (pos >= len || input[pos] !== '.')) {
    return undefined; // no leading digits and no '.' either: not a valid refresh directive
  }
  while (pos < len && (isDigit(input[pos]) || input[pos] === '.')) { pos++; }

  if (pos >= len || (input[pos] !== ';' && input[pos] !== ',' && !isSpace(input[pos]))) {
    return undefined; // nothing (valid) follows the time: no target
  }
  while (pos < len && isSpace(input[pos])) { pos++; }
  if (pos < len && (input[pos] === ';' || input[pos] === ',')) {
    pos++;
    while (pos < len && isSpace(input[pos])) { pos++; }
  }
  if (pos >= len) {
    return undefined; // separator with nothing after it: no explicit target
  }

  // Optional "url" + ws + "=" + ws prefix; on any mismatch, targetStart is left
  // at the position before this attempt, so the whole remainder becomes the
  // target -- exactly like a real browser's parser falling back.
  let targetStart = pos;
  if (input[pos] === 'u') {
    let p = pos + 1;
    if (p < len && input[p] === 'r') {
      p++;
      if (p < len && input[p] === 'l') {
        p++;
        while (p < len && isSpace(input[p])) { p++; }
        if (p < len && input[p] === '=') {
          p++;
          while (p < len && isSpace(input[p])) { p++; }
          targetStart = p;
        }
      }
    }
  }

  let target = input.slice(targetStart);
  const quote = target.charAt(0);
  if (quote === '"' || quote === '\'') {
    const closeAt = target.indexOf(quote, 1);
    target = closeAt === -1 ? target.slice(1) : target.slice(1, closeAt);
  }
  return target;
}

/**
 * True if a NORMALIZED (see normalizeUriForSchemeCheck) http-equiv/content pair
 * is a meta-refresh that would automatically navigate the reader to a
 * DIFFERENT origin. `<base>` is rejected outright above with no content check
 * because it retargets every relative URL in the document indiscriminately --
 * a blast radius no content inspection can bound. A meta-refresh's blast
 * radius is exactly one navigation, to its own parsed target, so unlike
 * `<base>` it CAN be judged by that target: no parsed target at all
 * (extractMetaRefreshTarget returns undefined/empty) is just a timed reload or
 * self-refresh of the current document, and a bare `#fragment` is a
 * same-document jump -- neither leaves the page. A scheme-less, non-network-path
 * target (`/moved`, `next.html`) can only resolve within whatever origin serves
 * this document, so it is no more dangerous than the relative `<a href>` links
 * this pipeline already allows through unchanged. What IS rejected: a target
 * carrying an explicit URI scheme (`https:`, `javascript:`, `data:`, any custom
 * scheme) or a leading `//` / `\\`-style network-path reference (browsers treat
 * two leading slash-or-backslash characters as an explicit authority for any
 * special scheme -- the well-known backslash-trick bypass) -- both can hand the
 * reader's browser to an attacker-controlled origin the instant the page loads,
 * with no click and no visible link to inspect first, the same silent off-site
 * redirect harm `<base>` guards against. `javascript:`/`vbscript:` targets are
 * caught here too (they carry a scheme), in addition to the dedicated
 * isDangerousUriScheme check used elsewhere.
 */
export function isDangerousMetaRefresh(normalizedHttpEquiv: string, normalizedContent: string): boolean {
  if (normalizedHttpEquiv !== 'refresh') {
    return false;
  }
  const target = extractMetaRefreshTarget(normalizedContent);
  if (!target || target.startsWith('#')) {
    return false;
  }
  return /^[/\\]{2}/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target);
}
