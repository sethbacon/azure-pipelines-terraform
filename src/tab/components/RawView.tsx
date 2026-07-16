import * as React from "react";
import { ansiToHtml } from "../ansi-to-html";

/** Maximum attachment size (bytes) to render inline. Larger content gets a download link. */
const MAX_RENDER_SIZE = 2 * 1024 * 1024; // 2 MB

/** Cap on the sanitized download filename length (excluding the fixed ".txt" suffix). */
const MAX_DOWNLOAD_NAME_LENGTH = 100;

/**
 * Sanitize an untrusted attachment name into a filesystem-safe download
 * filename (§5.3.2): allowlist `[A-Za-z0-9._-]`, cap length, never empty.
 */
export function sanitizeDownloadFilename(name: string): string {
    const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_DOWNLOAD_NAME_LENGTH);
    return sanitized.length > 0 ? sanitized : "terraform-output";
}

export interface RawViewProps {
    /** Untrusted attachment name — rendered as a text node only, never into an attribute/HTML sink. */
    name: string;
    /** Untrusted raw attachment body (plain text, may contain ANSI SGR sequences). */
    content: string;
}

/**
 * Renders raw (non-structured) terraform CLI output. This is the ONLY
 * component in the tab allowed to use `dangerouslySetInnerHTML` (§5.3/§8.1) —
 * it is exclusively fed through `ansiToHtml`, which HTML-escapes all text and
 * only ever emits a small, fixed set of `<span class="ansi-*">` wrapper tags.
 * Every structured component must render digest strings as plain React text
 * nodes instead; see the no-dangerouslySetInnerHTML tripwire test.
 */
export function RawView({ name, content }: RawViewProps): JSX.Element {
    if (content.length > MAX_RENDER_SIZE) {
        return (
            <div className="plan-oversize">
                <p>
                    Output for <strong>{name}</strong> is too large to render inline (
                    {(content.length / (1024 * 1024)).toFixed(1)} MB).
                </p>
                <a
                    href={URL.createObjectURL(new Blob([content], { type: "text/plain" }))}
                    download={`${sanitizeDownloadFilename(name)}.txt`}
                >
                    Download raw output
                </a>
            </div>
        );
    }

    return (
        <div className="raw-view">
            <div className="raw-view-name">{name}</div>
            {/* eslint-disable-next-line react/no-danger -- sole sanitizer-backed sink, see module doc comment */}
            <pre dangerouslySetInnerHTML={{ __html: ansiToHtml(content) }} />
        </div>
    );
}
