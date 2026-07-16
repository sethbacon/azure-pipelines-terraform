import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDigestText } from "./digest-model";
import { Digest, PlanResource } from "./digest-schema";
import { SummaryHeader } from "./components/SummaryHeader";
import { ResourceList } from "./components/ResourceList";
import { ResourceDiff } from "./components/ResourceDiff";
import { OutputsPanel } from "./components/OutputsPanel";
import { ApplyTimeline } from "./components/ApplyTimeline";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";

/**
 * TAB GOLDEN-FIXTURE REGRESSION (§12.3) + no-leak render tripwire.
 *
 * The WP-1 golden corpus (`Tests/fixtures/*.expected.json`) is the byte-frozen
 * REDACTED digest the task attaches. Here the tab's own safe-parse
 * (`parseDigestText`) + the structured render components are driven with those
 * exact goldens, so a UI/redaction-render regression — a component that stops
 * masking, echoes a raw value, or throws on a real digest — fails loudly. The
 * task-side suite (GoldenFixturesL0.ts) already proves the goldens themselves
 * don't leak; this proves the *render* of them doesn't either, and that the
 * unknown-schemaVersion path degrades gracefully instead of throwing.
 */

const FIXTURES_DIR = path.join(
  __dirname,
  "..",
  "..",
  "Tasks",
  "TerraformTask",
  "TerraformTaskV5",
  "Tests",
  "fixtures"
);

interface TabFixture {
  file: string;
  kind: "plan" | "apply";
  /** Fake secret literals that must never appear in the rendered markup. */
  secrets: string[];
  /** Masked/scrubbed markers that MUST appear (proves masking survived render). */
  markers?: string[];
  /** Whether to snapshot the rendered markup (UI regression guard). */
  snapshot?: boolean;
}

const FIXTURES: TabFixture[] = [
  { file: "plan-noop.expected.json", kind: "plan", secrets: [] },
  { file: "plan-create.expected.json", kind: "plan", secrets: [] },
  { file: "plan-replace.expected.json", kind: "plan", secrets: [] },
  { file: "plan-destroy.expected.json", kind: "plan", secrets: [] },
  {
    file: "plan-sensitive.expected.json",
    kind: "plan",
    secrets: ["SUPERSECRET_pw_9f3k", "TOK_abc123secret", "PORTSECRET_literal", "OUTPUTSECRET_xyz"],
    markers: ["(sensitive)", "(known after apply)"],
    snapshot: true,
  },
  { file: "plan-multi-provider.expected.json", kind: "plan", secrets: [] },
  { file: "plan-drift.expected.json", kind: "plan", secrets: [] },
  { file: "apply-success.expected.json", kind: "apply", secrets: [] },
  {
    file: "apply-partial-failure.expected.json",
    kind: "apply",
    secrets: ["APPLYSECRET_pw_42"],
    markers: ["(redacted)"],
    snapshot: true,
  },
];

/** Adapt a DriftResource into the PlanResource shape ResourceDiff renders. */
function driftAsPlanResource(drift: NonNullable<Extract<Digest, { kind: "plan" }>["drift"]>[number]): PlanResource {
  return { ...drift, actions: [] };
}

/** Render the composed plan detail exactly as tabContent.renderPlanDetail does. */
function renderPlanDetail(digest: Extract<Digest, { kind: "plan" }>): string {
  return renderToStaticMarkup(
    <div>
      <SummaryHeader
        title={digest.meta.name}
        kind="plan"
        counts={digest.summary}
        noChanges={digest.summary.noChanges}
        driftDetected={digest.summary.driftDetected}
        truncated={digest.truncated}
        truncationNotes={digest.truncationNotes}
        toolLabel={`${digest.tool.name} ${digest.tool.version}`}
      />
      <ResourceList
        resources={digest.resources}
        selectedAddress={null}
        onSelect={() => undefined}
        searchText=""
        onSearchTextChange={() => undefined}
      />
      {digest.resources.map((r) => (
        <ResourceDiff key={r.address} resource={r} />
      ))}
      {(digest.drift ?? []).map((d) => (
        <ResourceDiff key={d.address} resource={driftAsPlanResource(d)} />
      ))}
      <OutputsPanel outputs={digest.outputChanges} />
    </div>
  );
}

/** Render the composed apply detail exactly as tabContent.renderApplyDetail does. */
function renderApplyDetail(digest: Extract<Digest, { kind: "apply" }>): string {
  return renderToStaticMarkup(
    <div>
      <SummaryHeader
        title={digest.meta.name}
        kind="apply"
        counts={digest.summary}
        outcome={digest.outcome}
        truncated={digest.truncated}
        truncationNotes={digest.truncationNotes}
        toolLabel={`${digest.tool.name} ${digest.tool.version}`}
      />
      <ApplyTimeline resources={digest.resources} appliedBeforeFailure={digest.appliedBeforeFailure} />
      <DiagnosticsPanel diagnostics={digest.diagnostics} />
      <OutputsPanel outputs={digest.outputs} />
    </div>
  );
}

function renderDigest(digest: Digest): string {
  return digest.kind === "plan" ? renderPlanDetail(digest) : renderApplyDetail(digest);
}

describe("tab golden-fixture render regression (§12.3)", () => {
  for (const fx of FIXTURES) {
    describe(fx.file, () => {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, fx.file), "utf8");

      it("parses via parseDigestText into the expected kind", () => {
        const parsed = parseDigestText(raw);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.digest.kind).toBe(fx.kind);
          expect(parsed.unknownVersion).toBe(false);
        }
      });

      it("renders without leaking any known-secret literal and preserves masked markers", () => {
        const parsed = parseDigestText(raw);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const markup = renderDigest(parsed.digest);
        for (const secret of fx.secrets) {
          expect(markup).not.toContain(secret);
        }
        for (const marker of fx.markers ?? []) {
          expect(markup).toContain(marker);
        }
      });

      if (fx.snapshot) {
        it("matches the committed render snapshot (UI regression guard)", () => {
          const parsed = parseDigestText(raw);
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          expect(renderDigest(parsed.digest)).toMatchSnapshot();
        });
      }
    });
  }

  it("degrades gracefully on an unknown schemaVersion (999) without throwing or leaking", () => {
    // Take a real sensitive golden and bump only its schemaVersion. The tab must
    // still parse (best-effort), flag unknownVersion, keep the fail-closed masks,
    // and render without throwing.
    const base = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "plan-sensitive.expected.json"), "utf8"));
    base.schemaVersion = 999;
    const parsed = parseDigestText(JSON.stringify(base));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.unknownVersion).toBe(true);
    expect(parsed.detectedSchemaVersion).toBe(999);
    expect(parsed.notes.some((n) => n.includes("schemaVersion"))).toBe(true);

    let markup = "";
    expect(() => {
      markup = renderDigest(parsed.digest);
    }).not.toThrow();
    // Masking survives the degraded path.
    expect(markup).toContain("(sensitive)");
    for (const secret of ["SUPERSECRET_pw_9f3k", "TOK_abc123secret", "PORTSECRET_literal", "OUTPUTSECRET_xyz"]) {
      expect(markup).not.toContain(secret);
    }
  });
});
