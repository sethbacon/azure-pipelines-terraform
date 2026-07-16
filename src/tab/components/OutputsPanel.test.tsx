import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutputsPanel } from "./OutputsPanel";
import { OutputChange } from "../digest-schema";

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
});
