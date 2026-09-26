import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionStrip } from "./AttentionStrip";
import { AttentionItem } from "../attention";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { pivot: "plan", id, name: id, severity: "critical", reason: "1 to destroy", ...overrides };
}

describe("AttentionStrip", () => {
  it("renders nothing when there is nothing to review", () => {
    expect(renderToStaticMarkup(<AttentionStrip items={[]} onSelect={jest.fn()} />)).toBe("");
  });

  it("lists each item with its pivot, name, and reason under a counted title", () => {
    const html = renderToStaticMarkup(
      <AttentionStrip
        items={[item("prod-eastus#0", { name: "prod-eastus" }), item("apply#0", { pivot: "apply", name: "prod", severity: "warning", reason: "apply failed" })]}
        onSelect={jest.fn()}
      />
    );
    expect(html).toContain("Needs review (2)");
    expect(html).toContain('<li class="attention-item attention-critical">');
    expect(html).toContain('<span class="attention-item-pivot">Plan</span> <span class="attention-item-name">prod-eastus</span>');
    expect(html).toContain('<span class="attention-item-reason">: 1 to destroy</span>');
    expect(html).toContain('<span class="attention-item-pivot">Apply</span>');
    expect(html).toContain('<li class="attention-item attention-warning">');
  });

  it("opens the item's pivot and id when an entry is clicked", () => {
    const onSelect = jest.fn();
    const el = AttentionStrip({ items: [item("state#1", { pivot: "state" })], onSelect }) as React.ReactElement;
    const list = (el.props as { children: React.ReactElement[] }).children[1];
    const entries = (list.props as { children: React.ReactElement[] }).children;
    const button = (entries[0].props as { children: React.ReactElement }).children;
    (button.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledWith("state", "state#1");
  });

  it("collapses entries beyond maxShown into an 'and N more' line", () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`p${i}`));
    const html = renderToStaticMarkup(<AttentionStrip items={items} onSelect={jest.fn()} maxShown={3} />);
    expect(html).toContain("Needs review (5)");
    expect(html).toContain("p2");
    expect(html).not.toContain("p3");
    expect(html).toContain("and 2 more");
  });

  it("HTML-escapes an untrusted item name as a text node", () => {
    const html = renderToStaticMarkup(<AttentionStrip items={[item("x", { name: "<img src=x onerror=alert(1)>" })]} onSelect={jest.fn()} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
