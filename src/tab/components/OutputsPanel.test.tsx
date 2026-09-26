import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutputsPanel } from "./OutputsPanel";
import { OutputChange, OutputValue } from "../digest-schema";

describe("OutputsPanel", () => {
  it("renders each output name, action, and value", () => {
    const outputs: OutputChange[] = [{ name: "url", action: "create", value: { kind: "value", json: '"https://example.test"' } }];
    const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
    expect(html).toContain("url");
    expect(html).toMatch(/create/i);
    expect(html).toContain("https://example.test");
  });

  it('renders a sensitive output as "(sensitive)"', () => {
    const outputs: OutputChange[] = [{ name: "db_password", action: "create", value: { kind: "sensitive" } }];
    const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
    expect(html).toContain("(sensitive)");
    expect(html).not.toContain("db_password_value");
  });

  it('renders an unknown output as "(known after apply)"', () => {
    const outputs: OutputChange[] = [{ name: "instance_id", action: "create", value: { kind: "unknown" } }];
    const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
    expect(html).toContain("(known after apply)");
  });

  it("renders an empty state when there are no outputs", () => {
    const html = renderToStaticMarkup(<OutputsPanel outputs={[]} />);
    expect(html).toMatch(/no outputs/i);
  });

  it("HTML-escapes an output name as a text node", () => {
    const outputs: OutputChange[] = [{ name: "<img src=x onerror=alert(1)>", action: "create", value: { kind: "unknown" } }];
    const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("hard-caps rendered rows and shows a truncation banner (§5.5 bounded rendering)", () => {
    const outputs: OutputChange[] = Array.from({ length: 5 }, (_, i) => ({
      name: `o${i}`,
      action: "create",
      value: { kind: "value", json: `"v${i}"` },
    }));
    const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} maxRenderedRows={2} />);
    expect(html).toContain("o0");
    expect(html).toContain("o1");
    expect(html).not.toContain("o4");
    expect(html).toMatch(/truncated to 2 of 5 outputs/i);
  });

  describe("hiding unchanged plan outputs", () => {
    const outputs: OutputChange[] = [
      { name: "api_url", action: "update", value: { kind: "value", json: '"https://api.example.test"' } },
      { name: "region", action: "no-op", value: { kind: "value", json: '"eastus"' } },
      { name: "tenant", action: "no-op", value: { kind: "value", json: '"contoso"' } },
    ];

    it("lists only changed outputs and offers a toggle for the unchanged ones", () => {
      const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} onToggleUnchanged={jest.fn()} />);
      expect(html).toContain("api_url");
      expect(html).not.toContain("region");
      expect(html).toMatch(/aria-expanded="false">Show 2 unchanged outputs<\/button>/);
    });

    it("lists every output when showUnchanged is set", () => {
      const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} onToggleUnchanged={jest.fn()} showUnchanged={true} />);
      expect(html).toContain("region");
      expect(html).toContain("tenant");
      expect(html).toMatch(/aria-expanded="true">Hide 2 unchanged outputs<\/button>/);
    });

    it("says there are no output changes when every output is unchanged", () => {
      const html = renderToStaticMarkup(<OutputsPanel outputs={outputs.slice(1, 2)} onToggleUnchanged={jest.fn()} />);
      expect(html).toContain("No output changes.");
      expect(html).toContain("Show 1 unchanged output</button>");
      expect(html).not.toContain("<table");
    });

    it("calls onToggleUnchanged from the toggle", () => {
      const onToggleUnchanged = jest.fn();
      const el = OutputsPanel({ outputs, onToggleUnchanged }) as React.ReactElement;
      const children = (el.props as { children: React.ReactNode[] }).children;
      const toggle = children[children.length - 1] as React.ReactElement;
      (toggle.props as { onClick: () => void }).onClick();
      expect(onToggleUnchanged).toHaveBeenCalledTimes(1);
    });

    it("shows every output with no toggle when no toggle handler is given (apply/state outputs)", () => {
      const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
      expect(html).toContain("region");
      expect(html).not.toContain("outputs-panel-toggle");
    });
  });

  describe("state outputs (OutputValue, no action — digest spec §7.3)", () => {
    it("renders a state output's name and value without an Action column", () => {
      const outputs: OutputValue[] = [{ name: "db_endpoint", value: { kind: "value", json: '"db.example.test"' } }];
      const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
      expect(html).toContain("db_endpoint");
      expect(html).toContain("db.example.test");
      expect(html).not.toContain("<th>Action</th>");
    });

    it('renders a sensitive state output as "(sensitive)"', () => {
      const outputs: OutputValue[] = [{ name: "db_password", value: { kind: "sensitive" } }];
      const html = renderToStaticMarkup(<OutputsPanel outputs={outputs} />);
      expect(html).toContain("(sensitive)");
      expect(html).not.toContain("db_password_value");
    });
  });
});
