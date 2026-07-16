import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StateInventory, StateInventoryProps } from "./StateInventory";
import { StateResource } from "../digest-schema";

function resource(overrides: Partial<StateResource>): StateResource {
  return {
    address: "aws_instance.web",
    type: "aws_instance",
    name: "web",
    providerName: "registry.terraform.io/hashicorp/aws",
    mode: "managed",
    attributes: [],
    ...overrides,
  };
}

function baseProps(overrides: Partial<StateInventoryProps> = {}): StateInventoryProps {
  return {
    resources: [],
    selectedAddress: null,
    onSelect: jest.fn(),
    searchText: "",
    onSearchTextChange: jest.fn(),
    ...overrides,
  };
}

/** Render via the plain function call (no hooks used) to reach nested onClick/onChange closures. */
function callComponent(props: StateInventoryProps): React.ReactElement {
  return StateInventory(props) as React.ReactElement;
}

describe("StateInventory", () => {
  it("renders an empty state when there are no resources", () => {
    const html = renderToStaticMarkup(<StateInventory {...baseProps()} />);
    expect(html).toMatch(/no resources in state/i);
  });

  it("groups resources by type and shows group headings with counts", () => {
    const resources = [
      resource({ address: "aws_instance.a", type: "aws_instance" }),
      resource({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket" }),
      resource({ address: "aws_instance.b", type: "aws_instance" }),
    ];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources })} />);
    expect(html).toContain("aws_instance (2)");
    expect(html).toContain("aws_s3_bucket (1)");
    expect(html).toContain("aws_instance.a");
    expect(html).toContain("aws_instance.b");
    expect(html).toContain("aws_s3_bucket.assets");
  });

  it("renders address/type/provider/mode columns for a resource row", () => {
    const resources = [
      resource({
        address: "module.db.aws_db_instance.this[0]",
        type: "aws_db_instance",
        providerName: "registry.terraform.io/hashicorp/aws",
        mode: "managed",
        moduleAddress: "module.db",
      }),
    ];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources })} />);
    expect(html).toContain("module.db.aws_db_instance.this[0]");
    expect(html).toContain("aws_db_instance");
    expect(html).toContain("registry.terraform.io/hashicorp/aws");
    expect(html).toContain("managed");
    expect(html).toContain("module.db");
  });

  it("renders a data-source resource's mode distinctly from a managed resource", () => {
    const resources = [resource({ address: "data.aws_ami.latest", type: "aws_ami", mode: "data" })];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources })} />);
    expect(html).toContain("data.aws_ami.latest");
    expect(html).toMatch(/>data</);
  });

  it("filters resources by address substring using the (controlled) search text", () => {
    const resources = [resource({ address: "aws_instance.web" }), resource({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket" })];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, searchText: "s3" })} />);
    expect(html).not.toContain("aws_instance.web");
    expect(html).toContain("aws_s3_bucket.assets");
  });

  it("filters resources by type substring as well as address", () => {
    const resources = [resource({ address: "aws_instance.web", type: "aws_instance" }), resource({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket" })];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, searchText: "s3_bucket" })} />);
    expect(html).not.toContain("aws_instance.web");
    expect(html).toContain("aws_s3_bucket.assets");
  });

  it("calls onSearchTextChange when the search input changes (controlled, no internal state)", () => {
    const onSearchTextChange = jest.fn();
    const el = callComponent(baseProps({ resources: [resource({})], onSearchTextChange }));
    const input = findByTag(el, "input");
    expect(input).toBeTruthy();
    input!.props.onChange({ target: { value: "s3" } });
    expect(onSearchTextChange).toHaveBeenCalledWith("s3");
  });

  it("calls onSelect with the resource address when a row is clicked", () => {
    const onSelect = jest.fn();
    const resources = [resource({ address: "aws_instance.web" })];
    const el = callComponent(baseProps({ resources, onSelect }));
    const row = findByTestId(el, "state-row-aws_instance.web");
    expect(row).toBeTruthy();
    row!.props.onClick();
    expect(onSelect).toHaveBeenCalledWith("aws_instance.web");
  });

  it("renders an empty-filter state distinct from the no-resources state when search matches nothing", () => {
    const resources = [resource({ address: "aws_instance.web" })];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, searchText: "nomatch" })} />);
    expect(html).toMatch(/no resources match/i);
  });

  it("shows a truncated banner and caps rendered rows at maxRenderedRows", () => {
    const resources = Array.from({ length: 5 }, (_, i) => resource({ address: `aws_instance.r${i}` }));
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, maxRenderedRows: 3 })} />);
    expect(html).toMatch(/list truncated/i);
    expect(html).not.toContain("aws_instance.r4");
  });

  describe("expandable attributes", () => {
    it("does not render an attribute table when no resource is selected", () => {
      const resources = [
        resource({ address: "aws_instance.web", attributes: [{ name: "instance_type", value: { kind: "value", json: '"t3.micro"' } }] }),
      ];
      const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, selectedAddress: null })} />);
      expect(html).not.toContain("state-inventory-attrs-table");
      expect(html).not.toContain("instance_type");
    });

    it("renders the attribute table for the selected resource only", () => {
      const resources = [
        resource({ address: "aws_instance.a", attributes: [{ name: "instance_type", value: { kind: "value", json: '"t3.micro"' } }] }),
        resource({ address: "aws_instance.b", attributes: [{ name: "ami", value: { kind: "value", json: '"ami-123"' } }] }),
      ];
      const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, selectedAddress: "aws_instance.a" })} />);
      expect(html).toContain("instance_type");
      expect(html).toContain("t3.micro");
      expect(html).not.toContain("ami-123");
    });

    it('renders a sensitive attribute as "(sensitive)", never the underlying value', () => {
      const resources = [resource({ address: "aws_instance.web", attributes: [{ name: "password", value: { kind: "sensitive" } }] })];
      const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, selectedAddress: "aws_instance.web" })} />);
      expect(html).toContain("(sensitive)");
      expect(html).toContain("password");
    });

    it("renders an empty-attributes message when the selected resource has none", () => {
      const resources = [resource({ address: "aws_instance.web", attributes: [] })];
      const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, selectedAddress: "aws_instance.web" })} />);
      expect(html).toMatch(/no attributes recorded/i);
    });
  });

  it("HTML-escapes a malicious address as a text node", () => {
    const resources = [resource({ address: "<img src=x onerror=alert(1)>" })];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources })} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("HTML-escapes a malicious attribute name/value as text nodes", () => {
    const resources = [
      resource({
        address: "aws_instance.web",
        attributes: [{ name: "<img src=x onerror=alert(1)>", value: { kind: "value", json: '"<script>alert(2)</script>"' } }],
      }),
    ];
    const html = renderToStaticMarkup(<StateInventory {...baseProps({ resources, selectedAddress: "aws_instance.web" })} />);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;img");
  });
});

// --- tiny React-element tree helpers (no DOM/testing-library dependency) ---

function findByTag(node: React.ReactNode, tag: string): React.ReactElement | null {
  return findNode(node, (n) => React.isValidElement(n) && n.type === tag);
}

function findByTestId(node: React.ReactNode, testId: string): React.ReactElement | null {
  return findNode(
    node,
    (n) => React.isValidElement(n) && (n.props as Record<string, unknown>)["data-testid"] === testId
  );
}

/** Depth-first search over a React element tree, recursing through arrays-of-arrays (e.g. nested `.map()` output) and Fragments. */
function findNode(node: React.ReactNode, predicate: (n: React.ReactNode) => boolean): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  const children = (node.props as { children?: React.ReactNode }).children;
  return findNode(children, predicate);
}
