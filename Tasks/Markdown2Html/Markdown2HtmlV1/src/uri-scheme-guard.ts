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
