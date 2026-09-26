/**
 * Reading an attachment body under a byte ceiling.
 *
 * A declared Content-Length over the ceiling is refused before reading
 * (tabContent's loaders check it). Without one, reading the whole body and
 * measuring afterwards would already have buffered it, so the body is streamed
 * and the read stops as soon as it passes the ceiling.
 */

export type CappedBody = { ok: true; text: string; bytes: number } | { ok: false; bytesRead: number };

/** The parts of a Response this reads. */
export interface ReadableResponse {
    body?: ReadableStream<Uint8Array> | null;
    text(): Promise<string>;
}

/**
 * UTF-8 byte length of `text`, counted without encoding a copy (and without
 * TextEncoder, which not every environment the tab is tested in provides). A
 * lone surrogate counts as the 3-byte U+FFFD an encoder would emit.
 */
export function utf8Length(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        } else bytes += 3;
    }
    return bytes;
}

/**
 * The body as UTF-8 text with its byte length, or `ok: false` once more than
 * `maxBytes` has arrived (`bytesRead` is how far the read got, so a lower
 * bound on the real size). Falls back to `text()` where the response has no
 * readable stream.
 */
export async function readBodyCapped(response: ReadableResponse, maxBytes: number): Promise<CappedBody> {
    const stream = response.body;
    if (!stream || typeof stream.getReader !== "function") {
        const text = await response.text();
        const bytes = utf8Length(text);
        return bytes > maxBytes ? { ok: false, bytesRead: bytes } : { ok: true, text, bytes };
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, bytesRead: bytes };
        }
        chunks.push(value);
    }

    const decoder = new TextDecoder("utf-8");
    let text = "";
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    return { ok: true, text, bytes };
}
