import { AttentionSource, applyRisk, collectAttention, isFailedApply, planRisk, riskiestId } from "./attention";
import { ApplyDigest, PlanDigest, StateDigest } from "./digest-schema";

const ENVELOPE = {
  schemaVersion: 1 as const,
  producedBy: { task: "TerraformTaskV5" as const, taskVersion: "5.1.0" },
  tool: { name: "terraform" as const, version: "1.14.6" },
  meta: { name: "x", createdIso: "2026-09-26T00:00:00Z" },
  truncated: false,
};

function plan(id: string, summary: Partial<PlanDigest["summary"]> = {}, extra: Partial<PlanDigest> = {}): AttentionSource {
  const digest: PlanDigest = {
    ...ENVELOPE,
    kind: "plan",
    summary: { add: 0, change: 0, destroy: 0, replace: 0, read: 0, noChanges: true, driftDetected: false, ...summary },
    resources: [],
    outputChanges: [],
    ...extra,
  };
  return { id, name: id, status: "ok", digest };
}

function apply(id: string, outcome: "succeeded" | "failed", extra: Partial<ApplyDigest> = {}): AttentionSource {
  const digest: ApplyDigest = {
    ...ENVELOPE,
    kind: "apply",
    outcome,
    summary: { add: 0, change: 0, destroy: 0 },
    resources: [],
    diagnostics: [],
    outputs: [],
    ...extra,
  };
  return { id, name: id, status: "ok", digest };
}

function state(id: string, truncated = false): AttentionSource {
  const digest: StateDigest = {
    ...ENVELOPE,
    truncated,
    kind: "state",
    resources: [],
    outputs: [],
    summary: { resourceCount: 0, dataSourceCount: 0 },
  };
  return { id, name: id, status: "ok", digest };
}

const unreadable = (id: string): AttentionSource => ({ id, name: id, status: "error" });

describe("planRisk", () => {
  it("ranks destroys first, then unreadable or truncated, then drift, then changes, then no changes", () => {
    expect(planRisk(plan("a", { destroy: 1, noChanges: false }))).toBe(0);
    expect(planRisk(plan("b", {}, { planMode: "destroy" }))).toBe(0);
    expect(planRisk(unreadable("c"))).toBe(1);
    expect(planRisk(plan("d", { add: 1, noChanges: false }, { truncated: true }))).toBe(1);
    expect(planRisk(plan("e", { driftDetected: true }))).toBe(2);
    expect(planRisk(plan("f", { add: 1, noChanges: false }))).toBe(3);
    expect(planRisk(plan("g"))).toBe(4);
  });

  it("treats a digest of the wrong kind as unreadable", () => {
    expect(planRisk(apply("a", "succeeded"))).toBe(1);
  });
});

describe("applyRisk and isFailedApply", () => {
  it("ranks a failed apply first, then unreadable, then truncated, then the rest", () => {
    expect(applyRisk(apply("a", "failed"))).toBe(0);
    expect(applyRisk(unreadable("b"))).toBe(1);
    expect(applyRisk(apply("c", "succeeded", { truncated: true }))).toBe(2);
    expect(applyRisk(apply("d", "succeeded"))).toBe(3);
  });

  it("recognizes only a readable apply digest that failed", () => {
    expect(isFailedApply(apply("a", "failed"))).toBe(true);
    expect(isFailedApply(apply("b", "succeeded"))).toBe(false);
    expect(isFailedApply(unreadable("c"))).toBe(false);
    expect(isFailedApply(plan("d"))).toBe(false);
  });
});

describe("riskiestId", () => {
  it("picks the lowest risk, keeping list order among ties", () => {
    const items = [plan("calm"), plan("drift1", { driftDetected: true }), plan("drift2", { driftDetected: true })];
    expect(riskiestId(items, planRisk)).toBe("drift1");
  });

  it("returns null for an empty list", () => {
    expect(riskiestId([], planRisk)).toBeNull();
  });
});

describe("collectAttention", () => {
  it("lists nothing for a run with nothing to flag", () => {
    expect(collectAttention([plan("a", { add: 1, noChanges: false })], [apply("b", "succeeded")], [state("c")])).toEqual([]);
  });

  it("describes destroys with Terraform's own count, noting replacements", () => {
    const [item] = collectAttention([plan("prod", { destroy: 10, replace: 4, noChanges: false })], [], []);
    expect(item).toEqual({ pivot: "plan", id: "prod", name: "prod", severity: "critical", reason: "10 to destroy (4 replaced)" });
  });

  it("labels a destroy plan as such", () => {
    const [item] = collectAttention([plan("teardown", { destroy: 3, noChanges: false }, { planMode: "destroy" })], [], []);
    expect(item.reason).toBe("destroy plan, 3 to destroy");
  });

  it("counts drifted resources when the digest lists them, and says so plainly when it doesn't", () => {
    const drifted = {
      address: "a.b",
      type: "a",
      name: "b",
      providerName: "p",
      attributeChanges: [],
    };
    const [listed] = collectAttention([plan("p1", { driftDetected: true }, { drift: [drifted] })], [], []);
    expect(listed).toMatchObject({ severity: "warning", reason: "drift on 1 resource" });
    const [unlisted] = collectAttention([plan("p2", { driftDetected: true })], [], []);
    expect(unlisted.reason).toBe("drift detected");
  });

  it("joins several reasons for one plan into one entry", () => {
    const items = collectAttention([plan("p", { destroy: 1, driftDetected: true, noChanges: false }, { truncated: true })], [], []);
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe("1 to destroy · drift detected · partial view (truncated)");
  });

  it("reports a failed apply with its error count", () => {
    const errors = [
      { severity: "error" as const, summary: "boom" },
      { severity: "warning" as const, summary: "hmm" },
    ];
    expect(collectAttention([], [apply("a", "failed", { diagnostics: errors })], [])[0].reason).toBe("apply failed with 1 error");
    expect(collectAttention([], [apply("b", "failed")], [])[0].reason).toBe("apply failed");
  });

  it("flags unreadable and truncated digests in every pivot", () => {
    const items = collectAttention([unreadable("p")], [unreadable("a")], [unreadable("s"), state("t", true)]);
    expect(items.map((i) => `${i.pivot}:${i.id}:${i.reason}`)).toEqual([
      "apply:a:couldn't be read",
      "plan:p:couldn't be read",
      "state:s:couldn't be read",
      "state:t:partial view (truncated)",
    ]);
  });

  it("puts critical entries first and otherwise keeps apply, plan, state order", () => {
    const items = collectAttention(
      [plan("drifty", { driftDetected: true }), plan("destroys", { destroy: 2, noChanges: false })],
      [apply("failed", "failed")],
      [state("partial", true)]
    );
    expect(items.map((i) => i.id)).toEqual(["failed", "destroys", "drifty", "partial"]);
  });
});
