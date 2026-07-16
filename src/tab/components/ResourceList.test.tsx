import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceList, ResourceListProps } from "./ResourceList";
import { PlanResource } from "../digest-schema";

function resource(overrides: Partial<PlanResource>): PlanResource {
  return {
    address: "aws_instance.web",
    type: "aws_instance",
    name: "web",
    providerName: "registry.terraform.io/hashicorp/aws",
    actions: ["create"],
    attributeChanges: [],
    ...overrides,
  };
}

function baseProps(overrides: Partial<ResourceListProps> = {}): ResourceListProps {
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
function callComponent(props: ResourceListProps): React.ReactElement {
  return ResourceList(props) as React.ReactElement;
}

describe("ResourceList", () => {
  it("groups resources by action and shows group headings", () => {
    const resources = [
      resource({ address: "aws_instance.a", actions: ["create"] }),
      resource({ address: "aws_instance.b", actions: ["delete"] }),
      resource({ address: "aws_instance.c", actions: ["update"] }),
    ];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html).toMatch(/create/i);
    expect(html).toMatch(/delete/i);
    expect(html).toMatch(/update/i);
    expect(html).toContain("aws_instance.a");
    expect(html).toContain("aws_instance.b");
    expect(html).toContain("aws_instance.c");
  });

  it("groups a replace action distinctly from create/delete", () => {
    const resources = [resource({ address: "aws_instance.r", actions: ["replace"], actionReason: "replace_because_cannot_update" })];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html).toContain("aws_instance.r");
    expect(html).toMatch(/replace/i);
  });

  it("filters resources by address substring using the (controlled) search text", () => {
    const resources = [resource({ address: "aws_instance.web" }), resource({ address: "aws_s3_bucket.assets" })];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, searchText: "s3" })} />);
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
    const row = findByTestId(el, "resource-row-aws_instance.web");
    expect(row).toBeTruthy();
    row!.props.onClick();
    expect(onSelect).toHaveBeenCalledWith("aws_instance.web");
  });

  it("shows a truncated banner and caps rendered rows at maxRenderedRows", () => {
    const resources = Array.from({ length: 5 }, (_, i) => resource({ address: `aws_instance.r${i}` }));
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, maxRenderedRows: 3 })} />);
    expect(html).toMatch(/list truncated/i);
    expect(html).not.toContain("aws_instance.r4");
  });

  it("renders an empty state when there are no resources", () => {
    const html = renderToStaticMarkup(<ResourceList {...baseProps()} />);
    expect(html).toMatch(/no resource changes/i);
  });

  it("renders an empty-filter state distinct from the no-resources state when search matches nothing", () => {
    const resources = [resource({ address: "aws_instance.web" })];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, searchText: "nomatch" })} />);
    expect(html).toMatch(/no resources match/i);
  });

  it("HTML-escapes a malicious address as a text node", () => {
    const resources = [resource({ address: "<img src=x onerror=alert(1)>" })];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html).not.toContain("<img src=x");
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

/** Depth-first search over a React element tree, recursing through arrays-of-arrays (e.g. nested `.map()` output). */
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
