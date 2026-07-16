import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryHeader } from "./SummaryHeader";

describe("SummaryHeader", () => {
  it("renders plan counts and title as text nodes", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader
        title="plan-main"
        kind="plan"
        counts={{ add: 3, change: 1, destroy: 2, replace: 1, read: 0 }}
        noChanges={false}
      />
    );
    expect(html).toContain("plan-main");
    expect(html).toContain("+3");
    expect(html).toContain("~1");
    expect(html).toContain("-2");
  });

  it("shows a no-changes badge when noChanges is true", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="plan-noop" kind="plan" counts={{ add: 0, change: 0, destroy: 0 }} noChanges={true} />
    );
    expect(html).toContain("No changes");
  });

  it("shows a drift badge when driftDetected is true", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader
        title="plan-drift"
        kind="plan"
        counts={{ add: 0, change: 0, destroy: 0 }}
        driftDetected={true}
      />
    );
    expect(html).toContain("Drift detected");
  });

  it("renders an apply outcome badge (succeeded/failed)", () => {
    const succeeded = renderToStaticMarkup(
      <SummaryHeader title="apply-ok" kind="apply" counts={{ add: 1, change: 0, destroy: 0 }} outcome="succeeded" />
    );
    expect(succeeded).toContain("Succeeded");

    const failed = renderToStaticMarkup(
      <SummaryHeader title="apply-fail" kind="apply" counts={{ add: 1, change: 0, destroy: 0 }} outcome="failed" />
    );
    expect(failed).toContain("Failed");
  });

  it("shows a truncated banner with notes when truncated", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader
        title="plan-big"
        kind="plan"
        counts={{ add: 9999, change: 0, destroy: 0 }}
        truncated={true}
        truncationNotes={["resource list capped at 2000"]}
      />
    );
    expect(html).toContain("truncated");
    expect(html).toContain("resource list capped at 2000");
  });

  it("HTML-escapes a malicious title instead of injecting it", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title={'<img src=x onerror=alert(1)>'} kind="plan" counts={{ add: 0, change: 0, destroy: 0 }} />
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
