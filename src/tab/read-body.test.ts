import { readBodyCapped, utf8Length } from "./read-body";

function streamOf(chunks: Uint8Array[]): { body: ReadableStream<Uint8Array>; cancelled: () => boolean; text: () => Promise<string> } {
  let cancelled = false;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled, text: () => Promise.reject(new Error("text() must not be used when a stream exists")) };
}

describe("utf8Length", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["€", 3],
    ["😀", 4],
    ["\ud83d", 3], // lone high surrogate encodes as U+FFFD
    ["\ude00x", 4], // lone low surrogate, then ASCII
  ])("counts %p as %p bytes", (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes);
  });

  it("matches TextEncoder on mixed text", () => {
    const text = "plan: + résumé 😀 € done";
    expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
  });
});

describe("readBodyCapped", () => {
  it("decodes a streamed body across chunks, including a character split between them", async () => {
    const bytes = new TextEncoder().encode("{\"name\":\"€uro\"}");
    const euroStart = 9; // the 3-byte "€" spans chunk boundaries below
    const source = streamOf([bytes.slice(0, euroStart + 1), bytes.slice(euroStart + 1, euroStart + 2), bytes.slice(euroStart + 2)]);
    await expect(readBodyCapped(source, 1024)).resolves.toEqual({ ok: true, text: "{\"name\":\"€uro\"}", bytes: bytes.length });
  });

  it("stops reading, and cancels the stream, as soon as the body passes the ceiling", async () => {
    const chunk = new Uint8Array(10);
    const source = streamOf([chunk, chunk, chunk, chunk]);
    await expect(readBodyCapped(source, 25)).resolves.toEqual({ ok: false, bytesRead: 30 });
    expect(source.cancelled()).toBe(true);
  });

  it("accepts a body exactly at the ceiling", async () => {
    const source = streamOf([new TextEncoder().encode("12345")]);
    await expect(readBodyCapped(source, 5)).resolves.toMatchObject({ ok: true, bytes: 5 });
  });

  it("falls back to text() without a stream, measuring UTF-8 bytes", async () => {
    await expect(readBodyCapped({ text: async () => "é!" }, 10)).resolves.toEqual({ ok: true, text: "é!", bytes: 3 });
    await expect(readBodyCapped({ body: null, text: async () => "abcdef" }, 5)).resolves.toEqual({ ok: false, bytesRead: 6 });
  });
});
