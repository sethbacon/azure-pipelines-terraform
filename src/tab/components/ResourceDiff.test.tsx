import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceDiff } from "./ResourceDiff";
import { PlanResource } from "../digest-schema";

function resource(overrides: Partial<PlanResource>): PlanResource {
  return {
    address: "aws_instance.web",
    type: "aws_instance",
    name: "web",
    providerName: "registry.terraform.io/hashicorp/aws",
    actions: ["update"],
    attributeChanges: [],
    ...overrides,
  };
}

describe("ResourceDiff", () => {
  it("renders address, type, and actions", () => {
    const html = renderToStaticMarkup(<ResourceDiff resource={resource({})} />);
    expect(html).toContain("aws_instance.web");
    expect(html).toContain("aws_instance");
    expect(html).toMatch(/update/i);
  });

  it("shows an actionReason and replacePaths when present", () => {
    const html = renderToStaticMarkup(
      <ResourceDiff
        resource={resource({
          actions: ["delete", "create"],
          actionReason: "replace_because_cannot_update",
          replacePaths: ["ami", "availability_zone"],
        })}
      />
    );
    expect(html).toContain("Reason: must be replaced");
    expect(html).not.toContain("replace_because_cannot_update");
    expect(html).toContain("Forces replacement: ami, availability_zone");
  });

  describe("columns that fit the action", () => {
    const value = (json: string) => ({ kind: "value" as const, json });

    it("shows a created resource's new values in a single Value column", () => {
      const html = renderToStaticMarkup(
        <ResourceDiff
          resource={resource({
            actions: ["create"],
            attributeChanges: [
              { path: "name", before: value("null"), after: value('"web"') },
              { path: "id", before: value("null"), after: { kind: "unknown" } },
            ],
          })}
        />
      );
      expect(html).toContain('<th colSpan="2">Value</th>');
      expect(html).not.toContain(">null<");
      expect(html).toContain('<span class="value-placeholder">(known after apply)</span>');
    });

    it("shows a destroyed resource's current values in a single column", () => {
      const html = renderToStaticMarkup(
        <ResourceDiff resource={resource({ actions: ["delete"], attributeChanges: [{ path: "name", before: value('"old"'), after: value("null") }] })} />
      );
      expect(html).toContain('<th colSpan="2">Current value</th>');
      expect(html).toContain("&quot;old&quot;");
    });

    it("labels drift columns as what state recorded versus what the provider found", () => {
      const html = renderToStaticMarkup(
        <ResourceDiff mode="drift" resource={resource({ actions: [], attributeChanges: [{ path: "sku", before: value('"S1"'), after: value('"S2"') }] })} />
      );
      expect(html).toContain("<th>In state</th><th>Actual</th>");
      expect(html).not.toContain("resource-diff-actions");
    });
  });

  describe("forces replacement", () => {
    it("tags the attribute rows that force replacement, including a nested path, and lists only the rest", () => {
      const html = renderToStaticMarkup(
        <ResourceDiff
          resource={resource({
            actions: ["delete", "create"],
            replacePaths: ["location", "site_config[0].image", "zone"],
            attributeChanges: [
              { path: "location", before: { kind: "value", json: '"eastus"' }, after: { kind: "value", json: '"eastus2"' } },
              { path: "site_config", before: { kind: "value", json: '[{"image":"a"}]' }, after: { kind: "value", json: '[{"image":"b"}]' } },
              { path: "tags", before: { kind: "value", json: "{}" }, after: { kind: "value", json: '{"a":"b"}' } },
            ],
          })}
        />
      );
      expect(html).toContain('location<span class="forces-replacement">forces replacement</span>');
      expect(html).toContain('site_config<span class="forces-replacement">forces replacement</span>');
      expect(html).not.toContain('tags<span class="forces-replacement">');
      expect(html).toContain("Forces replacement: zone");
    });
  });

  describe("changed maps and lists", () => {
    it("lists only what changed, with both full values behind a disclosure", () => {
      const html = renderToStaticMarkup(
        <ResourceDiff
          resource={resource({
            attributeChanges: [
              {
                path: "tags",
                before: { kind: "value", json: '{"env":"prod","owner":"cloud-eng","team":"x"}' },
                after: { kind: "value", json: '{"env":"prod","owner":"platform","reviewed":"2026-09-01"}' },
              },
            ],
          })}
        />
      );
      expect(html).toContain('<span class="value-diff-path">owner</span>');
      expect(html).toContain('<span class="value-diff-path">reviewed</span> added: ');
      expect(html).toContain('<span class="value-diff-path">team</span> removed: ');
      expect(html).not.toContain('<span class="value-diff-path">env</span>');
      expect(html).toContain("1 unchanged");
      expect(html).toContain("<summary>Full values</summary>");
    });

    it("keeps side-by-side columns for scalar changes", () => {
      const html = renderToStaticMarkup(
        <ResourceDiff
          resource={resource({ attributeChanges: [{ path: "sku", before: { kind: "value", json: '"P1v3"' }, after: { kind: "value", json: '"P2v3"' } }] })}
        />
      );
      expect(html).toContain('<td class="resource-diff-before">&quot;P1v3&quot;</td><td class="resource-diff-after">&quot;P2v3&quot;</td>');
      expect(html).not.toContain("value-diff");
    });
  });

  it("drops the address header and reason in the inline variant but keeps the forced-replacement paths", () => {
    const html = renderToStaticMarkup(
      <ResourceDiff
        variant="inline"
        resource={resource({
          actions: ["delete", "create"],
          actionReason: "replace_because_cannot_update",
          replacePaths: ["ami"],
        })}
      />
    );
    expect(html).toContain('class="resource-diff resource-diff-inline"');
    expect(html).not.toContain("resource-diff-header");
    expect(html).not.toContain("replace_because_cannot_update");
    expect(html).toContain("Forces replacement: ami");
  });

  it("renders each attribute change with before/after values", () => {
    const html = renderToStaticMarkup(
      <ResourceDiff
        resource={resource({
          attributeChanges: [
            { path: "instance_type", before: { kind: "value", json: '"t2.micro"' }, after: { kind: "value", json: '"t3.micro"' } },
          ],
        })}
      />
    );
    expect(html).toContain("instance_type");
    expect(html).toContain("t2.micro");
    expect(html).toContain("t3.micro");
  });

  it('renders a sensitive attribute as "(sensitive)" and never leaks it as (value)', () => {
    const html = renderToStaticMarkup(
      <ResourceDiff
        resource={resource({
          attributeChanges: [{ path: "password", before: { kind: "unknown" }, after: { kind: "sensitive" } }],
        })}
      />
    );
    expect(html).toContain("(sensitive)");
    expect(html).toContain("(known after apply)");
  });

  it("renders an omitted-too-large value placeholder", () => {
    const html = renderToStaticMarkup(
      <ResourceDiff
        resource={resource({
          attributeChanges: [{ path: "big_blob", before: { kind: "unknown" }, after: { kind: "omitted", reason: "too-large" } }],
        })}
      />
    );
    expect(html).toContain("omitted");
  });

  it("shows a no-attribute-changes message when there are none (e.g. a create with no before)", () => {
    const html = renderToStaticMarkup(<ResourceDiff resource={resource({ attributeChanges: [] })} />);
    expect(html).toMatch(/no attribute changes/i);
  });

  it("HTML-escapes an attribute path and value as text nodes", () => {
    const html = renderToStaticMarkup(
      <ResourceDiff
        resource={resource({
          attributeChanges: [
            {
              path: "<script>alert(1)</script>",
              before: { kind: "unknown" },
              after: { kind: "value", json: '"<img src=x onerror=alert(1)>"' },
            },
          ],
        })}
      />
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});
