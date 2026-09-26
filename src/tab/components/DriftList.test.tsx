import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DriftList } from "./DriftList";
import { DriftResource } from "../digest-schema";

function drifted(address: string): DriftResource {
  return {
    address,
    type: "azurerm_subnet",
    name: address.split(".").pop() as string,
    providerName: "registry.terraform.io/hashicorp/azurerm",
    attributeChanges: [
      { path: "service_endpoints", before: { kind: "value", json: '["Microsoft.Storage"]' }, after: { kind: "sensitive" } },
    ],
  };
}

describe("DriftList", () => {
  it("renders one diff per drifted resource with its address and masked values", () => {
    const html = renderToStaticMarkup(<DriftList drift={[drifted("azurerm_subnet.a"), drifted("azurerm_subnet.b")]} />);
    expect(html).toContain("azurerm_subnet.a");
    expect(html).toContain("azurerm_subnet.b");
    expect(html.match(/class="resource-diff"/g)).toHaveLength(2);
    expect(html).toContain("(sensitive)");
    expect(html).toMatch(/changes made outside terraform/i);
  });

  it("hard-caps rendered diffs and shows a truncation banner (§5.5 bounded rendering)", () => {
    const drift = Array.from({ length: 5 }, (_, i) => drifted(`azurerm_subnet.s${i}`));
    const html = renderToStaticMarkup(<DriftList drift={drift} maxRenderedRows={2} />);
    expect(html).toContain("azurerm_subnet.s1");
    expect(html).not.toContain("azurerm_subnet.s2");
    expect(html).toMatch(/truncated to 2 of 5 drifted resources/i);
  });

  it("HTML-escapes a drifted address as a text node", () => {
    const html = renderToStaticMarkup(<DriftList drift={[drifted("<img src=x onerror=alert(1)>")]} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
