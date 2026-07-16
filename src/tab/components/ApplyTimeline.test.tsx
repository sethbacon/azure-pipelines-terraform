import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplyTimeline } from "./ApplyTimeline";
import { ApplyResource } from "../digest-schema";

function res(overrides: Partial<ApplyResource>): ApplyResource {
  return { address: "aws_instance.web", action: "create", status: "complete", ...overrides };
}

describe("ApplyTimeline", () => {
  it("renders each resource with address, action, status", () => {
    const html = renderToStaticMarkup(
      <ApplyTimeline resources={[res({ address: "a", action: "create", status: "complete", durationMs: 1500 })]} />
    );
    expect(html).toContain("a");
    expect(html).toMatch(/create/i);
    expect(html).toMatch(/complete/i);
    expect(html).toContain("1.5s");
  });

  it("marks an errored resource distinctly", () => {
    const html = renderToStaticMarkup(<ApplyTimeline resources={[res({ status: "errored" })]} />);
    expect(html).toMatch(/errored/i);
  });

  it("renders a duration in milliseconds when under a second", () => {
    const html = renderToStaticMarkup(<ApplyTimeline resources={[res({ durationMs: 250 })]} />);
    expect(html).toContain("250ms");
  });

  it("omits a duration when not provided", () => {
    const html = renderToStaticMarkup(<ApplyTimeline resources={[res({ durationMs: undefined })]} />);
    expect(html).not.toContain("undefined");
  });

  it("shows appliedBeforeFailure addresses when provided", () => {
    const html = renderToStaticMarkup(
      <ApplyTimeline resources={[res({})]} appliedBeforeFailure={["aws_instance.a", "aws_instance.b"]} />
    );
    expect(html).toContain("aws_instance.a");
    expect(html).toContain("aws_instance.b");
    expect(html).toMatch(/before/i);
  });

  it("renders an empty state when there are no resources", () => {
    const html = renderToStaticMarkup(<ApplyTimeline resources={[]} />);
    expect(html).toMatch(/no resources/i);
  });

  it("HTML-escapes an address as a text node", () => {
    const html = renderToStaticMarkup(<ApplyTimeline resources={[res({ address: "<img src=x onerror=alert(1)>" })]} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
