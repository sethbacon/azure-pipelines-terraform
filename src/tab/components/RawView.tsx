import * as React from "react";
import { ansiToHtml } from "../ansi-to-html";

/** Maximum attachment size (bytes) to render inline. Larger content gets a download button. */
const MAX_RENDER_SIZE = 2 * 1024 * 1024; // 2 MB

/** Cap on the sanitized download filename length (excluding the fixed ".txt" suffix). */
const MAX_DOWNLOAD_NAME_LENGTH = 100;

/**
 * How long a download's object URL outlives the click that created it. The
 * browser resolves the URL when the download actually starts, which is not
 * guaranteed to happen inside `click()`, so revoking it synchronously can
 * fail the download. Holding it this long costs one copy of the attachment
 * per click, released on a timer.
 */
const DOWNLOAD_URL_REVOKE_DELAY_MS = 40 * 1000;

/**
 * Sanitize an untrusted attachment name into a filesystem-safe download
 * filename (§5.3.2): allowlist `[A-Za-z0-9._-]`, cap length, never empty.
 */
export function sanitizeDownloadFilename(name: string): string {
    const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_DOWNLOAD_NAME_LENGTH);
    return sanitized.length > 0 ? sanitized : "terraform-output";
}

/**
 * Saves `content` as a `<name>.txt` download. The Blob and its object URL are
 * created here, on click, and never during render: RawView re-renders on
 * every tab state change (each search keystroke), and an object URL created
 * during render would pin another full copy of the attachment every time,
 * with nothing to revoke it.
 */
export function downloadRawContent(name: string, content: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadFilename(name)}.txt`;
    document.body.appendChild(link);
    try {
        link.click();
    } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
    }
}

export interface RawViewProps {
    /** Untrusted attachment name — rendered as a text node only, never into an attribute/HTML sink. */
    name: string;
    /** Untrusted raw attachment body. */
    content: string;
    /**
     * `"ansi"` is for legacy `terraform-plan-results` CLI output only: its SGR
     * color codes are converted by `ansiToHtml` and injected through the tab's
     * one `dangerouslySetInnerHTML` sink. `"text"` renders the body as a plain
     * React text node; structured digests (JSON, no ANSI codes) always use it,
     * so digest content never reaches the HTML sink.
     */
    format: "ansi" | "text";
}

/**
 * Renders raw (non-structured) terraform output. This is the ONLY component
 * in the tab allowed to use `dangerouslySetInnerHTML` (§5.3/§8.1), and only in
 * the `"ansi"` format, where it is exclusively fed through `ansiToHtml`, which
 * HTML-escapes all text and only ever emits a small, fixed set of
 * `<span class="ansi-*">` wrapper tags. Every structured component must render
 * digest strings as plain React text nodes instead; see the
 * no-dangerouslySetInnerHTML tripwire test.
 */
export function RawView({ name, content, format }: RawViewProps): JSX.Element {
    if (content.length > MAX_RENDER_SIZE) {
        return (
            <div className="plan-oversize">
                <p>
                    Output for <strong>{name}</strong> is too large to render inline (
                    {(content.length / (1024 * 1024)).toFixed(1)} MB).
                </p>
                <button type="button" onClick={() => downloadRawContent(name, content)}>
                    Download raw output
                </button>
            </div>
        );
    }

    return (
        <div className="raw-view">
            <div className="raw-view-name">{name}</div>
            {format === "ansi" ? (
                // eslint-disable-next-line react/no-danger -- sole sanitizer-backed sink, see module doc comment
                <pre dangerouslySetInnerHTML={{ __html: ansiToHtml(content) }} />
            ) : (
                <pre>{content}</pre>
            )}
        </div>
    );
}
