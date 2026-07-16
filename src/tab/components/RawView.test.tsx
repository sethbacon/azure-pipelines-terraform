import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RawView } from "./RawView";
import { ansiToHtml } from "../ansi-to-html";

describe("RawView", () => {
  it("routes content through ansiToHtml before rendering (no raw HTML injected)", () => {
    const rawContent = '<script>alert(1)</script>\x1b[31mred & <b>bold</b>\x1b[0m';
    const html = renderToStaticMarkup(<RawView name="plan.txt" content={rawContent} />);
    expect(html).toContain(ansiToHtml(rawContent));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows the attachment name as a text node (not injected as HTML)", () => {
    const html = renderToStaticMarkup(<RawView name="<img src=x>" content="plain output" />);
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("renders a download link instead of inline output when content exceeds the render-size cap", () => {
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    const html = renderToStaticMarkup(<RawView name="huge-plan.txt" content={oversized} />);
    expect(html).toContain("too large to render inline");
    expect(html).toContain("Download raw output");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});
