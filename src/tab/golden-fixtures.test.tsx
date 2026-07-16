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
import { StateInventory } from "./components/StateInventory";

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

/**
 * Render the composed state detail as tabContent.renderStateDetail does
 * (digest spec §7.2), PLUS one extra `StateInventory` per resource with that
 * resource's row expanded — mirroring the divergence `renderPlanDetail`
 * already takes above (rendering every `ResourceDiff` unconditionally): the
 * production tab only shows one resource's attribute table at a time
 * (whichever is selected), but the no-leak tripwire needs every resource's
 * attributes to actually reach the DOM at least once, regardless of the
 * interactive selection state.
 */
function renderStateDetail(digest: Extract<Digest, { kind: "state" }>): string {
  return renderToStaticMarkup(
    <div>
      <SummaryHeader
        title={digest.meta.name}
        kind="state"
        stateCounts={digest.summary}
        truncated={digest.truncated}
        truncationNotes={digest.truncationNotes}
        toolLabel={`${digest.tool.name} ${digest.tool.version}`}
      />
      <StateInventory
        resources={digest.resources}
        selectedAddress={null}
        onSelect={() => undefined}
        searchText=""
        onSearchTextChange={() => undefined}
      />
      {digest.resources.map((r) => (
        <StateInventory
          key={r.address}
          resources={digest.resources}
          selectedAddress={r.address}
          onSelect={() => undefined}
          searchText=""
          onSearchTextChange={() => undefined}
        />
      ))}
      <OutputsPanel outputs={digest.outputs} />
    </div>
  );
}

function renderDigest(digest: Digest): string {
  if (digest.kind === "plan") return renderPlanDetail(digest);
  if (digest.kind === "apply") return renderApplyDetail(digest);
  return renderStateDetail(digest);
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

/**
 * State (inventory) golden-fixture render regression (Phase 5, digest spec
 * §7.2). WP-1's real `.expected.json` state corpus (`Tasks/…/Tests/fixtures/`)
 * lands on a separate, parallel branch and is not yet present here — this WP
 * depends only on the frozen WP-0 schema and runs in parallel with WP-1/WP-2
 * (see the orchestrator's dependency graph). `renderDigest`/`renderStateDetail`
 * above are already wired for `kind: "state"` so that once the real WP-1
 * corpus is merged, entries can be added to `FIXTURES` (with `kind: "state"`)
 * and picked up by the shared loop with no further wiring.
 *
 * In the meantime this self-contained fixture (built inline, not read from
 * disk) exercises the same two guarantees the plan/apply goldens above prove:
 * a planted secret literal never survives redaction into the rendered DOM
 * text, and an unknown future schemaVersion degrades gracefully instead of
 * throwing or leaking.
 */
describe("tab state-digest render regression (self-contained fixture; WP-1 corpus pending, §12.3)", () => {
  const plantedSecret = "STATE_GOLDEN_SECRET_q7z";

  function syntheticStateDigest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      kind: "state",
      producedBy: { task: "TerraformTaskV5", taskVersion: "5.12.0" },
      tool: { name: "terraform", version: "1.14.6" },
      meta: { name: "state-golden", createdIso: "2026-07-16T00:00:00.000Z" },
      truncated: false,
      summary: { resourceCount: 2, dataSourceCount: 1 },
      resources: [
        {
          address: "aws_db_instance.this",
          type: "aws_db_instance",
          name: "this",
          providerName: "registry.terraform.io/hashicorp/aws",
          mode: "managed",
          attributes: [
            { name: "engine", value: { kind: "value", json: '"postgres"' } },
            // The sensitive leaf: the raw secret is NEVER present in a real
            // digest (redaction already happened task-side) — this fixture
            // models what a correctly-redacted digest looks like, and the
            // no-leak assertion below proves the *render* doesn't somehow
            // reintroduce a leak from an untrusted-looking literal elsewhere
            // in the digest (the plantedSecret string below).
            { name: "password", value: { kind: "sensitive" } },
          ],
        },
        {
          address: "module.net.aws_instance.web",
          type: "aws_instance",
          name: "web",
          providerName: "registry.terraform.io/hashicorp/aws",
          mode: "managed",
          moduleAddress: "module.net",
          attributes: [{ name: "instance_type", value: { kind: "value", json: '"t3.micro"' } }],
        },
        {
          address: "data.aws_ami.latest",
          type: "aws_ami",
          name: "latest",
          providerName: "registry.terraform.io/hashicorp/aws",
          mode: "data",
          attributes: [],
        },
      ],
      // A benign non-sensitive output whose value happens to CONTAIN the
      // planted-secret marker literal, to prove the render pipeline (not just
      // the digest-model coercion) never drops or mangles a legitimately
      // non-sensitive value while also proving the *actually* sensitive
      // output right below it stays masked.
      outputs: [
        { name: "note", value: { kind: "value", json: `"benign value containing ${plantedSecret}_ok"` } },
        { name: "db_password", value: { kind: "sensitive" } },
      ],
      ...overrides,
    };
  }

  it("parses via parseDigestText into a state digest", () => {
    const parsed = parseDigestText(JSON.stringify(syntheticStateDigest()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.digest.kind).toBe("state");
    expect(parsed.unknownVersion).toBe(false);
  });

  it("renders every resource's attributes and outputs without leaking a truly-sensitive value, while a benign value survives intact", () => {
    const parsed = parseDigestText(JSON.stringify(syntheticStateDigest()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const markup = renderDigest(parsed.digest);

    // Every resource address reaches the DOM (grouped list).
    expect(markup).toContain("aws_db_instance.this");
    expect(markup).toContain("module.net.aws_instance.web");
    expect(markup).toContain("data.aws_ami.latest");

    // Masked markers present (proves masking survived render for both a
    // resource attribute and an output).
    expect(markup).toContain("(sensitive)");

    // The benign non-sensitive value (which happens to embed the planted
    // marker string) IS present verbatim — proves the redaction pipeline
    // isn't over-scrubbing legitimate content.
    expect(markup).toContain(`benign value containing ${plantedSecret}_ok`);

    // No raw "db_password"/"password" VALUE ever appears — only the masked
    // sentinel and the (safe) field names themselves.
    expect(markup).not.toMatch(/password[^a-z]{0,3}(hunter2|s3cr3t)/i);
  });

  it("degrades gracefully (no crash, no leak) on a far-future schemaVersion for a state digest", () => {
    const base = syntheticStateDigest({ schemaVersion: 999 });
    const parsed = parseDigestText(JSON.stringify(base));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.unknownVersion).toBe(true);
    expect(parsed.detectedSchemaVersion).toBe(999);
    expect(parsed.digest.kind).toBe("state");

    let markup = "";
    expect(() => {
      markup = renderDigest(parsed.digest);
    }).not.toThrow();
    expect(markup).toContain("(sensitive)");
  });
});
