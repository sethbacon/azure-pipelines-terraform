import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RawView, sanitizeDownloadFilename } from "./RawView";
import * as ansi from "../ansi-to-html";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("RawView", () => {
  it("ansi format routes content through ansiToHtml before rendering (no raw HTML injected)", () => {
    const rawContent = '<script>alert(1)</script>\x1b[31mred & <b>bold</b>\x1b[0m';
    const html = renderToStaticMarkup(<RawView name="plan.txt" content={rawContent} format="ansi" />);
    expect(html).toContain(ansi.ansiToHtml(rawContent));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("text format renders the body as a plain text node, never through ansiToHtml", () => {
    const ansiSpy = jest.spyOn(ansi, "ansiToHtml");
    const rawContent = '{"note":"<script>alert(1)</script>"}\x1b[31m';
    const html = renderToStaticMarkup(<RawView name="plan-summary" content={rawContent} format="text" />);
    expect(ansiSpy).not.toHaveBeenCalled();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    // An escape sequence is shown as-is rather than interpreted into markup.
    expect(html).toContain("\x1b[31m");
    expect(html).not.toContain('class="ansi-');
  });

  it("shows the attachment name as a text node (not injected as HTML) in both formats", () => {
    for (const format of ["ansi", "text"] as const) {
      const html = renderToStaticMarkup(<RawView name="<img src=x>" content="plain output" format={format} />);
      expect(html).toContain("&lt;img src=x&gt;");
      expect(html).not.toContain("<img");
    }
  });

  it("renders a download button instead of inline output when content exceeds the render-size cap", () => {
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    const html = renderToStaticMarkup(<RawView name="huge-plan.txt" content={oversized} format="ansi" />);
    expect(html).toContain("too large to render inline");
    expect(html).toContain('<button type="button">Download raw output</button>');
    expect(html).not.toContain("<pre");
  });

  it("creates no Blob object URL while rendering oversized content, however often it re-renders", () => {
    const createSpy = jest.spyOn(URL, "createObjectURL");
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    for (let i = 0; i < 14; i++) {
      renderToStaticMarkup(<RawView name="huge-plan.txt" content={oversized} format="text" />);
    }
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("sanitizeDownloadFilename", () => {
  it("replaces every character outside [A-Za-z0-9._-]", () => {
    expect(sanitizeDownloadFilename("../plan <prod>/main.tf")).toBe(".._plan__prod__main.tf");
  });

  it("caps the name at 100 characters", () => {
    expect(sanitizeDownloadFilename("a".repeat(150))).toBe("a".repeat(100));
  });

  it("falls back to a fixed name when nothing is left", () => {
    expect(sanitizeDownloadFilename("")).toBe("terraform-output");
  });
});
