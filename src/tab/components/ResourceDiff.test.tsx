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
    expect(html).toContain("replace_because_cannot_update");
    expect(html).toContain("ami");
    expect(html).toContain("availability_zone");
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
