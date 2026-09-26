import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceList, ResourceListProps, countChangedResources } from "./ResourceList";
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
    showUnchanged: false,
    onToggleUnchanged: jest.fn(),
    actionFilter: null,
    onActionFilterChange: jest.fn(),
    ...overrides,
  };
}

/** Render via the plain function call (no hooks used) to reach nested onClick/onChange closures. */
function callComponent(props: ResourceListProps): React.ReactElement {
  return ResourceList(props) as React.ReactElement;
}

describe("ResourceList", () => {
  it("groups resources by action and labels groups with Terraform's plan-summary vocabulary", () => {
    const resources = [
      resource({ address: "aws_instance.a", actions: ["create"] }),
      resource({ address: "aws_instance.b", actions: ["delete"] }),
      resource({ address: "aws_instance.c", actions: ["update"] }),
      resource({ address: "aws_instance.d", actions: ["read"] }),
      resource({ address: "aws_instance.e", actions: ["forget"] }),
      resource({ address: "aws_instance.f", actions: [] }),
    ];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html).toContain(">Add (1)</div>");
    expect(html).toContain(">Destroy (1)</div>");
    expect(html).toContain(">Change (1)</div>");
    expect(html).toContain(">Read (1)</div>");
    expect(html).toContain(">Forget (1)</div>");
    expect(html).toContain("Unchanged (1)");
    // The raw JSON action names must not leak into the UI.
    expect(html).not.toMatch(/>(create|delete|update|no-op) \(/);
    expect(html).toContain("aws_instance.a");
    expect(html).toContain("aws_instance.b");
    expect(html).toContain("aws_instance.c");
  });

  it("groups a replace action distinctly from create/delete", () => {
    const resources = [resource({ address: "aws_instance.r", actions: ["replace"], actionReason: "replace_because_cannot_update" })];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html).toContain("aws_instance.r");
    expect(html).toContain(">Replace (1)</div>");
  });

  it("words the action reason the way Terraform's CLI does", () => {
    const resources = [resource({ address: "aws_instance.gone", actions: ["delete"], actionReason: "delete_because_no_resource_config" })];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html).toContain('<span class="resource-row-reason">no longer in configuration</span>');
  });

  it("tags a replacement that creates the new resource before destroying the old one", () => {
    const resources = [
      resource({ address: "aws_instance.cbd", actions: ["create", "delete"] }),
      resource({ address: "aws_instance.dbc", actions: ["delete", "create"] }),
    ];
    const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
    expect(html.match(/create before destroy/g)).toHaveLength(1);
    expect(html.indexOf("create before destroy")).toBeGreaterThan(html.indexOf("aws_instance.cbd"));
    expect(html.indexOf("create before destroy")).toBeLessThan(html.indexOf("aws_instance.dbc"));
  });

  describe("import", () => {
    it("puts an import-only resource in its own group instead of burying it under Unchanged", () => {
      const resources = [
        resource({ address: "aws_instance.imported", actions: ["no-op"], importing: true }),
        resource({ address: "aws_instance.untouched", actions: ["no-op"] }),
      ];
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
      expect(html).toContain(">Import (1)</div>");
      expect(html).toContain("Unchanged (1)");
      // Visible without expanding the Unchanged group.
      expect(html).toContain('data-testid="resource-row-aws_instance.imported"');
    });

    it("leaves an import that also changes in its action group and tags it instead of double-listing it", () => {
      const resources = [resource({ address: "aws_instance.both", actions: ["update"], importing: true })];
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
      expect(html).toContain(">Change (1)</div>");
      expect(html).not.toContain(">Import (1)</div>");
      expect(html).toContain('<span class="badge badge-import">Import</span>');
      expect(html.match(/data-testid="resource-row-aws_instance\.both"/g)).toHaveLength(1);
    });

    it("does not tag rows inside the Import group (the heading already says so)", () => {
      const resources = [resource({ address: "aws_instance.imported", actions: ["no-op"], importing: true })];
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
      expect(html).toContain(">Import (1)</div>");
      expect(html).not.toContain("badge-import");
    });
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

  describe("unchanged resources", () => {
    const resources = [
      resource({ address: "aws_instance.changed", actions: ["update"] }),
      resource({ address: "aws_instance.same1", actions: ["no-op"] }),
      resource({ address: "aws_instance.same2", actions: ["no-op"] }),
    ];

    it("hides unchanged rows behind a collapsed toggle by default", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
      expect(html).toContain("aws_instance.changed");
      expect(html).toContain("Unchanged (2)");
      expect(html).not.toContain("aws_instance.same1");
      expect(html).toMatch(/class="resource-group-toggle" aria-expanded="false"/);
    });

    it("lists unchanged rows when showUnchanged is set", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, showUnchanged: true })} />);
      expect(html).toContain("aws_instance.same1");
      expect(html).toContain("aws_instance.same2");
      expect(html).toMatch(/class="resource-group-toggle" aria-expanded="true"/);
    });

    it("calls onToggleUnchanged when the Unchanged heading is clicked", () => {
      const onToggleUnchanged = jest.fn();
      const el = callComponent(baseProps({ resources, onToggleUnchanged }));
      const toggle = findNode(el, (n) => React.isValidElement(n) && (n.props as { className?: string }).className === "resource-group-toggle");
      expect(toggle).toBeTruthy();
      toggle!.props.onClick();
      expect(onToggleUnchanged).toHaveBeenCalledTimes(1);
    });

    it("reports search matches inside the collapsed group as a count instead of rows", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, searchText: "same1" })} />);
      expect(html).toContain("Unchanged (1)");
      expect(html).not.toContain('data-testid="resource-row-aws_instance.same1"');
      expect(html).not.toMatch(/no resources match/i);
    });
  });

  describe("inline diff", () => {
    const resources = [
      resource({
        address: "aws_instance.a",
        actions: ["update"],
        attributeChanges: [{ path: "instance_type", before: { kind: "value", json: '"t2.micro"' }, after: { kind: "value", json: '"t3.micro"' } }],
      }),
      resource({ address: "aws_instance.b", actions: ["update"] }),
    ];

    it("expands the selected resource's diff directly under its own row", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, selectedAddress: "aws_instance.a" })} />);
      const rowAt = html.indexOf('data-testid="resource-row-aws_instance.a"');
      const diffAt = html.indexOf("resource-diff-inline");
      const nextRowAt = html.indexOf('data-testid="resource-row-aws_instance.b"');
      expect(rowAt).toBeGreaterThan(-1);
      expect(diffAt).toBeGreaterThan(rowAt);
      expect(diffAt).toBeLessThan(nextRowAt);
      expect(html).toContain("t3.micro");
    });

    it("drops the diff's own address header, which the row already shows", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, selectedAddress: "aws_instance.a" })} />);
      expect(html).not.toContain("resource-diff-header");
    });

    it("marks only the selected row as expanded", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, selectedAddress: "aws_instance.a" })} />);
      expect(html).toMatch(/data-testid="resource-row-aws_instance\.a" class="resource-row selected" aria-expanded="true"/);
      expect(html).toMatch(/data-testid="resource-row-aws_instance\.b" class="resource-row" aria-expanded="false"/);
      expect(html.match(/resource-diff-inline/g)).toHaveLength(1);
    });

    it("renders no diff when nothing is selected", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
      expect(html).not.toContain("resource-diff");
    });
  });

  describe("row budget", () => {
    const resources = [
      resource({ address: "aws_instance.same1", actions: ["no-op"] }),
      resource({ address: "aws_instance.new1", actions: ["create"] }),
      resource({ address: "aws_instance.same2", actions: ["no-op"] }),
      resource({ address: "aws_instance.gone1", actions: ["delete"] }),
      resource({ address: "aws_instance.same3", actions: ["no-op"] }),
    ];

    it("does not count a collapsed Unchanged group against the budget", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, maxRenderedRows: 2 })} />);
      expect(html).toContain("aws_instance.new1");
      expect(html).toContain("aws_instance.gone1");
      expect(html).not.toMatch(/list truncated/i);
    });

    it("spends the budget on changed groups before unchanged rows", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, maxRenderedRows: 2, showUnchanged: true })} />);
      expect(html).toContain("aws_instance.new1");
      expect(html).toContain("aws_instance.gone1");
      expect(html).not.toContain('data-testid="resource-row-aws_instance.same1"');
      expect(html).toMatch(/list truncated to 2 of 5 matching resources/i);
    });
  });

  describe("action filter", () => {
    const resources = [
      resource({ address: "aws_instance.gone", actions: ["delete"] }),
      resource({ address: "aws_instance.new", actions: ["create"] }),
      resource({ address: "aws_instance.new2", actions: ["create"] }),
      resource({ address: "aws_instance.same", actions: ["no-op"] }),
    ];

    it("offers an All chip and one chip per changed group, with counts", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources })} />);
      expect(html).toContain('aria-pressed="true">All</button>');
      expect(html).toContain('class="action-chip action-chip-delete" aria-pressed="false">Destroy 1</button>');
      expect(html).toContain('class="action-chip action-chip-create" aria-pressed="false">Add 2</button>');
      expect(html).not.toContain("action-chip-no-op");
    });

    it("offers no chips when only one changed group is listed", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources: resources.slice(1) })} />);
      expect(html).not.toContain("action-filter");
    });

    it("shows only the filtered group and leaves Unchanged out", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, actionFilter: "delete", showUnchanged: true })} />);
      expect(html).toContain("aws_instance.gone");
      expect(html).not.toContain("resource-row-aws_instance.new");
      expect(html).not.toContain("Unchanged (");
      expect(html).toContain('class="action-chip action-chip-delete" aria-pressed="true">Destroy 1</button>');
    });

    it("toggles a chip: selects its group, and clicking the active chip clears the filter", () => {
      const onActionFilterChange = jest.fn();
      const chips = (filter: ResourceListProps["actionFilter"]): React.ReactElement[] => {
        const el = callComponent(baseProps({ resources, actionFilter: filter, onActionFilterChange }));
        const group = findNode(el, (n) => React.isValidElement(n) && (n.props as { className?: string }).className === "action-filter")!;
        const [all, groupChips] = (group.props as { children: [React.ReactElement, React.ReactElement[]] }).children;
        return [all, ...groupChips];
      };
      chips(null)[1].props.onClick();
      expect(onActionFilterChange).toHaveBeenLastCalledWith("delete");
      chips("delete")[1].props.onClick();
      expect(onActionFilterChange).toHaveBeenLastCalledWith(null);
      chips("create")[0].props.onClick();
      expect(onActionFilterChange).toHaveBeenLastCalledWith(null);
    });

    it("keeps the active chip at zero matches and explains the empty list", () => {
      const html = renderToStaticMarkup(<ResourceList {...baseProps({ resources, actionFilter: "delete", searchText: "new" })} />);
      expect(html).toContain('aria-pressed="true">Destroy 0</button>');
      expect(html).toMatch(/no resources match this filter/i);
    });
  });

  describe("countChangedResources", () => {
    it("counts everything outside the Unchanged group, including import-only instances", () => {
      const resources = [
        resource({ address: "a", actions: ["create"] }),
        resource({ address: "b", actions: ["no-op"] }),
        resource({ address: "c", actions: ["no-op"], importing: true }),
        resource({ address: "d", actions: [] }),
        resource({ address: "e", actions: ["delete", "create"] }),
      ];
      expect(countChangedResources(resources)).toBe(3);
    });

    it("returns 0 for an all-unchanged plan and caches per array without cross-talk", () => {
      const unchanged = [resource({ address: "x", actions: ["no-op"] })];
      const changed = [resource({ address: "y", actions: ["update"] })];
      expect(countChangedResources(unchanged)).toBe(0);
      expect(countChangedResources(changed)).toBe(1);
      expect(countChangedResources(unchanged)).toBe(0);
    });
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
