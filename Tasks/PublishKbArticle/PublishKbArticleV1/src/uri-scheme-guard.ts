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
 * Element (tag) names rejected outright by both layers: <form> has no
 * legitimate use in a KB article fragment and an action="javascript:..."
 * attribute is otherwise a blocklist-fragile per-attribute check (#446
 * follow-up); the SVG SMIL animation elements (animate/animateColor/
 * animateTransform/animateMotion/set) can dynamically assign a javascript:
 * URI into a referenced attribute (e.g. an <a>'s href) at RUNTIME via their
 * to/from/values attributes, a vector the static attribute-value scan above
 * cannot catch. Lower-cased tag names -- match by comparing a lower-cased
 * tagName, NOT a CSS tag selector: per the HTML5 foreign-content parsing
 * algorithm, cheerio/parse5 preserves the SVG spec's camelCase spelling for
 * animateColor/animateTransform/animateMotion (unlike ordinary HTML tags,
 * which are lower-cased), and a css-select tag selector does not match these
 * foreign-namespaced nodes by name in either case (verified empirically).
 */
export const DANGEROUS_TAGS = new Set(['form', 'animate', 'animatecolor', 'animatetransform', 'animatemotion', 'set']);

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
