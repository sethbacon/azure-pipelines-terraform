import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ValueDiff } from "./ValueDiff";
import { JsonValueText, RedactedValueText } from "./ValueText";
import { diffStructured } from "../value-diff";

describe("ValueDiff", () => {
  it("renders changed, added and removed entries with their signs, and the unchanged count", () => {
    const diff = diffStructured('{"a":1,"b":2,"c":3}', '{"a":1,"b":5,"d":4}')!;
    const html = renderToStaticMarkup(<ValueDiff diff={diff} />);
    expect(html).toContain(
      '<li class="value-diff-entry value-diff-changed"><span class="value-diff-sign" aria-hidden="true">~</span> <span class="value-diff-path">b</span>: <span class="value-diff-before">2</span> → <span class="value-diff-after">5</span></li>'
    );
    expect(html).toContain('<span class="value-diff-path">c</span> removed: <span class="value-diff-before">3</span>');
    expect(html).toContain('<span class="value-diff-path">d</span> added: <span class="value-diff-after">4</span>');
    expect(html).toContain("1 unchanged");
  });

  it("labels the attribute's own list members as items", () => {
    const diff = diffStructured('["Microsoft.Storage"]', '["Microsoft.KeyVault","Microsoft.Storage"]')!;
    const html = renderToStaticMarkup(<ValueDiff diff={diff} />);
    expect(html).toContain('<span class="value-diff-path">item</span> added: <span class="value-diff-after">&quot;Microsoft.KeyVault&quot;</span>');
  });

  it("labels a change to the whole value", () => {
    const html = renderToStaticMarkup(
      <ValueDiff diff={{ entries: [{ kind: "changed", path: "", before: 1, after: 2 }], more: 0, unchanged: 0, fromStrings: false }} />
    );
    expect(html).toContain('<span class="value-diff-path">(value)</span>');
  });

  it("styles sentinel strings inside values as placeholders", () => {
    const diff = diffStructured('{"key":"old"}', '{"key":"(known after apply)"}')!;
    const html = renderToStaticMarkup(<ValueDiff diff={diff} />);
    expect(html).toContain('<span class="value-placeholder">(known after apply)</span>');
  });

  it("says so when no difference is visible after redaction", () => {
    const diff = diffStructured('{"p":"(sensitive)"}', '{"p":"(sensitive)"}')!;
    expect(renderToStaticMarkup(<ValueDiff diff={diff} />)).toContain("No visible difference");
  });

  it("notes a JSON document inside a string, and counts entries past the cap", () => {
    const html = renderToStaticMarkup(
      <ValueDiff diff={{ entries: [{ kind: "added", path: "x", value: 1 }], more: 2, unchanged: 0, fromStrings: true }} />
    );
    expect(html).toContain("JSON document inside a string");
    expect(html).toContain("and 2 more changes");
  });

  it("HTML-escapes keys and values as text", () => {
    const diff = diffStructured('{"<b>":"<img src=x>"}', '{"<b>":"<script>"}')!;
    const html = renderToStaticMarkup(<ValueDiff diff={diff} />);
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("value text", () => {
  it("styles the three placeholders and leaves real values plain", () => {
    expect(renderToStaticMarkup(<RedactedValueText value={{ kind: "sensitive" }} />)).toBe('<span class="value-placeholder">(sensitive)</span>');
    expect(renderToStaticMarkup(<RedactedValueText value={{ kind: "unknown" }} />)).toContain("(known after apply)");
    expect(renderToStaticMarkup(<RedactedValueText value={{ kind: "omitted", reason: "too-large" }} />)).toContain("value-placeholder");
    expect(renderToStaticMarkup(<RedactedValueText value={{ kind: "value", json: '"x"' }} />)).toBe("&quot;x&quot;");
  });

  it("cuts off a long inline JSON value", () => {
    const html = renderToStaticMarkup(<JsonValueText value={"a".repeat(400)} />);
    expect(html.length).toBeLessThan(320);
    expect(html.endsWith("…")).toBe(true);
  });
});
