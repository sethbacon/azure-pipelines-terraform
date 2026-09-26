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

  it("renders the import count ahead of add/change/destroy, matching Terraform's summary line", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="plan-import" kind="plan" counts={{ add: 0, change: 20, destroy: 0, import: 7 }} />
    );
    expect(html).toContain("7 to import");
    expect(html.indexOf("7 to import")).toBeLessThan(html.indexOf("+0"));
  });

  it("omits the import count when there is nothing to import", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="plan-main" kind="plan" counts={{ add: 1, change: 0, destroy: 0, import: 0 }} />
    );
    expect(html).not.toContain("to import");
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

  it("shows a Destroy badge on a plan digest with destroyMode set (digest spec §7.1)", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader
        title="destroy-plan"
        kind="plan"
        counts={{ add: 0, change: 0, destroy: 3 }}
        destroyMode={true}
      />
    );
    expect(html).toContain("Destroy");
    expect(html).toContain("badge-destroy");
  });

  it("does not show a Destroy badge on a normal plan (destroyMode absent/false)", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="normal-plan" kind="plan" counts={{ add: 1, change: 0, destroy: 0 }} />
    );
    expect(html).not.toContain("badge-destroy");
  });

  it("ignores destroyMode for a non-plan kind (apply)", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="apply-a" kind="apply" counts={{ add: 1, change: 0, destroy: 0 }} destroyMode={true} />
    );
    expect(html).not.toContain("badge-destroy");
  });

  it("renders state-inventory counts (resources/data sources) instead of add/change/destroy", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="state-main" kind="state" stateCounts={{ resourceCount: 5, dataSourceCount: 2 }} />
    );
    expect(html).toContain("5 resources");
    expect(html).toContain("2 data sources");
    expect(html).not.toContain("count-add");
  });

  it("renders no counts row for a state digest when stateCounts is omitted", () => {
    const html = renderToStaticMarkup(<SummaryHeader title="state-main" kind="state" />);
    expect(html).not.toContain("summary-header-counts");
  });

  it("shows how long an apply took", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="apply" kind="apply" counts={{ add: 1, change: 0, destroy: 0 }} durationMs={734_000} />
    );
    expect(html).toContain('<span class="summary-header-duration">took 12m 14s</span>');
  });

  it("marks a truncated digest as a partial view, with its notes behind a disclosure", () => {
    const html = renderToStaticMarkup(
      <SummaryHeader title="p" kind="plan" counts={{ add: 1, change: 0, destroy: 0 }} truncated={true} truncationNotes={["only note"]} />
    );
    expect(html).toContain('role="note"><strong>Partial view.</strong>');
    expect(html).toContain("<summary>1 note</summary>");
  });

  it("caps the listed truncation notes and counts the rest", () => {
    const notes = Array.from({ length: 25 }, (_, i) => `note ${i}`);
    const html = renderToStaticMarkup(
      <SummaryHeader title="p" kind="plan" counts={{ add: 1, change: 0, destroy: 0 }} truncated={true} truncationNotes={notes} />
    );
    expect(html).toContain("<summary>25 notes</summary>");
    expect(html).toContain("note 19");
    expect(html).not.toContain("note 20<");
    expect(html).toContain("and 5 more");
  });

  describe("origin line", () => {
    it("shows the step, working directory and a log link that opens in a new tab", () => {
      const html = renderToStaticMarkup(
        <SummaryHeader
          title="p"
          kind="plan"
          originLabel="Plan prod › Plan › Terraform plan"
          workingDirectory="environments/prod"
          logUrl="https://dev.example.test/org/proj/_build/results?buildId=1&view=logs"
        />
      );
      expect(html).toContain('<span class="summary-header-origin-label">Plan prod › Plan › Terraform plan</span>');
      expect(html).toContain('<span class="summary-header-workdir">environments/prod</span>');
      expect(html).toContain(
        '<a class="summary-header-log" href="https://dev.example.test/org/proj/_build/results?buildId=1&amp;view=logs" target="_blank" rel="noopener noreferrer">View step log</a>'
      );
    });

    it("never turns a non-http(s) URL into a link", () => {
      const html = renderToStaticMarkup(<SummaryHeader title="p" kind="plan" originLabel="x" logUrl="javascript:alert(1)" />);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("javascript:");
    });

    it("flags a digest a step other than the Terraform task published", () => {
      const html = renderToStaticMarkup(<SummaryHeader title="p" kind="plan" notFromTerraformTask={true} />);
      expect(html).toContain('<span class="badge badge-untrusted">Not from the Terraform task</span>');
    });

    it("renders no origin line when nothing is known about where the digest came from", () => {
      const html = renderToStaticMarkup(<SummaryHeader title="p" kind="plan" notFromTerraformTask={false} />);
      expect(html).not.toContain("summary-header-origin");
    });
  });

  it("shows the partial-view banner without a notes disclosure when there are no notes", () => {
    const html = renderToStaticMarkup(<SummaryHeader title="p" kind="plan" counts={{ add: 1, change: 0, destroy: 0 }} truncated={true} />);
    expect(html).toContain("Partial view.");
    expect(html).not.toContain("<details");
  });
});
