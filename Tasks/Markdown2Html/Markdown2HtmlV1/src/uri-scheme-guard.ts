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
export const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'noscript', 'form', 'link', 'animate', 'animatecolor', 'animatetransform', 'animatemotion', 'set']);

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

/** True if a NORMALIZED http-equiv/content pair is a meta-refresh redirect to a dangerous scheme. */
export function isDangerousMetaRefresh(normalizedHttpEquiv: string, normalizedContent: string): boolean {
  return normalizedHttpEquiv === 'refresh' &&
    (normalizedContent.includes('javascript:') || normalizedContent.includes('vbscript:'));
}
