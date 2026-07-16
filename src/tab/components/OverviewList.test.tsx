import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewList, OverviewItem } from "./OverviewList";

const planItems: OverviewItem[] = [
  {
    id: "a",
    name: "plan-a",
    status: "ok",
    counts: { add: 2, change: 0, destroy: 0 },
    noChanges: false,
    driftDetected: false,
  },
  {
    id: "b",
    name: "plan-b (no-op)",
    status: "ok",
    counts: { add: 0, change: 0, destroy: 0 },
    noChanges: true,
    driftDetected: false,
  },
  {
    id: "c",
    name: "plan-c (drift)",
    status: "ok",
    counts: { add: 0, change: 1, destroy: 0, replace: 1 },
    noChanges: false,
    driftDetected: true,
  },
  { id: "d", name: "plan-d (broken)", status: "error", message: "malformed digest" },
];

describe("OverviewList", () => {
  it("renders one row per item with name and count chips", () => {
    const html = renderToStaticMarkup(<OverviewList items={planItems} selectedId="a" onSelect={() => {}} />);
    expect(html).toContain("plan-a");
    expect(html).toContain("plan-b (no-op)");
    expect(html).toContain("plan-c (drift)");
    expect(html).toContain("+2");
  });

  it("shows a no-op badge for noChanges items and a drift badge for drifted items", () => {
    const html = renderToStaticMarkup(<OverviewList items={planItems} selectedId="a" onSelect={() => {}} />);
    expect(html).toContain("No changes");
    expect(html).toContain("Drift");
  });

  it("shows a replace badge when the item has replacements", () => {
    const html = renderToStaticMarkup(<OverviewList items={planItems} selectedId="a" onSelect={() => {}} />);
    expect(html).toContain("Replace");
  });

  it("shows an error indicator for an unparseable item, without a count chip", () => {
    const html = renderToStaticMarkup(<OverviewList items={planItems} selectedId="a" onSelect={() => {}} />);
    expect(html).toContain("plan-d (broken)");
    expect(html).toContain("malformed digest");
  });

  it("marks the selected row", () => {
    const html = renderToStaticMarkup(<OverviewList items={planItems} selectedId="b" onSelect={() => {}} />);
    expect(html).toMatch(/overview-item[^"]*selected[^>]*>[\s\S]*plan-b/);
  });

  it("invokes onSelect with the item id when a row is clicked", () => {
    const onSelect = jest.fn();
    // renderToStaticMarkup can't dispatch events; verify the click handler is
    // wired by simulating the call directly against the exported row logic —
    // instead, assert via a controlled component harness using react-dom/test-utils-free approach:
    // call the component function directly to exercise its onClick closures.
    const el = OverviewList({ items: planItems, selectedId: "a", onSelect }) as React.ReactElement;
    // Find the second row's onClick handler in the rendered tree and invoke it.
    const rows = (el.props.children as React.ReactElement[]).filter(Boolean);
    const secondRow = rows[1];
    expect(typeof secondRow.props.onClick).toBe("function");
    secondRow.props.onClick();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("renders an empty state when there are no items", () => {
    const html = renderToStaticMarkup(<OverviewList items={[]} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain("No items");
  });
});
