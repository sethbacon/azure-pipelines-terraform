/**
 * SGR code → CSS class mapping for the subset of ANSI codes terraform emits.
 */
const SGR_CLASS_MAP: Record<string, string> = {
    "1": "ansi-bold",
    "30": "ansi-black",
    "31": "ansi-red",
    "32": "ansi-green",
    "33": "ansi-yellow",
    "34": "ansi-blue",
    "35": "ansi-magenta",
    "36": "ansi-cyan",
    "37": "ansi-white",
    "90": "ansi-grey",
};

/**
 * Convert ANSI SGR escape codes (ECMA-48 standard) to HTML spans with CSS classes.
 *
 * Uses a state-machine approach that tracks open spans to guarantee balanced tags.
 * Multi-code sequences (e.g. \x1b[1;31m) are fully handled — each recognised code
 * opens its own span, and reset (code 0) closes all currently open spans.
 */
export function ansiToHtml(text: string): string {
    const parts: string[] = [];
    let openSpans = 0;

    // Match SGR sequences (\x1b[...m) or runs of plain text between them.
    // Also matches any other CSI sequences so they can be stripped.
    const TOKEN_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[a-zA-Z]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(text)) !== null) {
        // Emit plain text before this match (HTML-escaped)
        if (match.index > lastIndex) {
            parts.push(escapeHtml(text.slice(lastIndex, match.index)));
        }
        lastIndex = TOKEN_RE.lastIndex;

        // Non-SGR CSI sequence (no capture group) — strip it
        if (match[1] === undefined) continue;

        const codes = match[1].split(";");
        for (const code of codes) {
            if (code === "0" || code === "") {
                // Reset: close all open spans
                while (openSpans > 0) {
                    parts.push("</span>");
                    openSpans--;
                }
            } else {
                const className = SGR_CLASS_MAP[code];
                if (className) {
                    parts.push(`<span class="${className}">`);
                    openSpans++;
                }
            }
        }
    }

    // Emit any trailing plain text
    if (lastIndex < text.length) {
        parts.push(escapeHtml(text.slice(lastIndex)));
    }

    // Close any spans left open at end-of-input
    while (openSpans > 0) {
        parts.push("</span>");
        openSpans--;
    }

    return parts.join("");
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
