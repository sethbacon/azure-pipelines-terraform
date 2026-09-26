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

  it("hard-caps rendered resource rows and shows a truncation banner (§5.5 bounded rendering)", () => {
    const many = Array.from({ length: 5 }, (_, i) => res({ address: `r.${i}` }));
    const html = renderToStaticMarkup(<ApplyTimeline resources={many} maxRenderedRows={2} />);
    expect(html).toContain("r.0");
    expect(html).toContain("r.1");
    expect(html).not.toContain("r.4");
    expect(html).toMatch(/truncated to 2 of 5 resources/i);
  });

  it("hard-caps the appliedBeforeFailure list and banners it, tolerating duplicate addresses", () => {
    const html = renderToStaticMarkup(
      <ApplyTimeline resources={[res({})]} appliedBeforeFailure={["a.dup", "a.dup", "b", "c"]} maxRenderedRows={2} />
    );
    expect(html).toMatch(/truncated to 2 of 4 addresses/i);
  });

  describe("failed apply", () => {
    const resources = [
      res({ address: "done.one", status: "complete" }),
      res({ address: "broke.one", status: "errored" }),
      res({ address: "hung.one", status: "started" }),
      res({ address: "done.two", status: "complete" }),
    ];

    it("leads with errored resources, then unfinished, then completed, each under a counted heading", () => {
      const html = renderToStaticMarkup(<ApplyTimeline resources={resources} outcome="failed" />);
      const at = (text: string): number => html.indexOf(text);
      expect(html).toContain("Errored (1)");
      expect(html).toContain("Still running when the apply stopped (1)");
      expect(html).toContain("Completed (2)");
      expect(at("broke.one")).toBeLessThan(at("hung.one"));
      expect(at("hung.one")).toBeLessThan(at("done.one"));
    });

    it("spends the row budget on errored resources first", () => {
      const html = renderToStaticMarkup(<ApplyTimeline resources={resources} outcome="failed" maxRenderedRows={1} />);
      expect(html).toContain("broke.one");
      expect(html).not.toContain("hung.one");
      expect(html).not.toContain("done.one");
      expect(html).toMatch(/truncated to 1 of 4 resources/i);
    });

    it("keeps one reported-order list for a successful apply", () => {
      const html = renderToStaticMarkup(<ApplyTimeline resources={resources} outcome="succeeded" />);
      expect(html).not.toContain("apply-timeline-group");
      expect(html.indexOf("done.one")).toBeLessThan(html.indexOf("broke.one"));
    });
  });

  describe("slowest resources", () => {
    it("names the three slowest, slowest first, with their durations", () => {
      const html = renderToStaticMarkup(
        <ApplyTimeline
          resources={[
            res({ address: "a", durationMs: 1000 }),
            res({ address: "b", durationMs: 89_200 }),
            res({ address: "c", durationMs: 5000 }),
            res({ address: "d", durationMs: 700 }),
            res({ address: "e" }),
          ]}
        />
      );
      expect(html).toContain(
        'Slowest: <span class="apply-timeline-address">b</span> (1m 29s), <span class="apply-timeline-address">c</span> (5.0s), <span class="apply-timeline-address">a</span> (1.0s)'
      );
    });

    it("omits the line when fewer than two resources reported a duration", () => {
      const html = renderToStaticMarkup(<ApplyTimeline resources={[res({ address: "a", durationMs: 1000 }), res({ address: "b" })]} />);
      expect(html).not.toContain("Slowest");
    });
  });
});
