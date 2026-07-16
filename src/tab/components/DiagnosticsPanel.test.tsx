import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { Diagnostic } from "../digest-schema";

describe("DiagnosticsPanel", () => {
  it("renders severity, summary, and address", () => {
    const diagnostics: Diagnostic[] = [{ severity: "error", summary: "Invalid value", address: "aws_instance.web" }];
    const html = renderToStaticMarkup(<DiagnosticsPanel diagnostics={diagnostics} />);
    expect(html).toMatch(/error/i);
    expect(html).toContain("Invalid value");
    expect(html).toContain("aws_instance.web");
  });

  it("renders detail when present", () => {
    const diagnostics: Diagnostic[] = [{ severity: "warning", summary: "Deprecated attribute", detail: "Use new_attr instead." }];
    const html = renderToStaticMarkup(<DiagnosticsPanel diagnostics={diagnostics} />);
    expect(html).toContain("Use new_attr instead.");
  });

  it("omits the detail section entirely when detail is absent (safe-default diagnostic mode)", () => {
    const diagnostics: Diagnostic[] = [{ severity: "warning", summary: "Deprecated attribute" }];
    const html = renderToStaticMarkup(<DiagnosticsPanel diagnostics={diagnostics} />);
    expect(html).not.toContain("diagnostics-panel-detail");
  });

  it("sorts errors before warnings", () => {
    const diagnostics: Diagnostic[] = [
      { severity: "warning", summary: "warn-first" },
      { severity: "error", summary: "err-first" },
    ];
    const html = renderToStaticMarkup(<DiagnosticsPanel diagnostics={diagnostics} />);
    expect(html.indexOf("err-first")).toBeLessThan(html.indexOf("warn-first"));
  });

  it("renders an empty state (no diagnostics) distinctly", () => {
    const html = renderToStaticMarkup(<DiagnosticsPanel diagnostics={[]} />);
    expect(html).toMatch(/no diagnostics/i);
  });

  it("HTML-escapes freeform summary/detail text as text nodes (no script injection)", () => {
    const diagnostics: Diagnostic[] = [
      { severity: "error", summary: '<script>alert(1)</script>', detail: '<img src=x onerror=alert(1)>' },
    ];
    const html = renderToStaticMarkup(<DiagnosticsPanel diagnostics={diagnostics} />);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});
