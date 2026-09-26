import { isExactMatch, matchPlanToApply, pairAppliesWithPlans } from "./plan-match";
import { ApplyDigest, ApplyResource, PlanDigest, PlanResource } from "./digest-schema";

const ENVELOPE = {
  schemaVersion: 1 as const,
  producedBy: { task: "TerraformTaskV5" as const, taskVersion: "5.1.0" },
  tool: { name: "terraform" as const, version: "1.14.6" },
  meta: { name: "prod", createdIso: "2026-09-26T00:00:00Z" },
  truncated: false,
};

function planned(address: string, actions: PlanResource["actions"]): PlanResource {
  return { address, type: "t", name: "n", providerName: "p", actions, attributeChanges: [] };
}

function plan(resources: PlanResource[], truncated = false): PlanDigest {
  return {
    ...ENVELOPE,
    truncated,
    kind: "plan",
    summary: { add: 0, change: 0, destroy: 0, replace: 0, read: 0, noChanges: false, driftDetected: false },
    resources,
    outputChanges: [],
  };
}

function apply(resources: ApplyResource[], outcome: "succeeded" | "failed" = "succeeded", truncated = false): ApplyDigest {
  return { ...ENVELOPE, truncated, kind: "apply", outcome, summary: { add: 0, change: 0, destroy: 0 }, resources, diagnostics: [], outputs: [] };
}

const done = (address: string, action: ApplyResource["action"]): ApplyResource => ({ address, action, status: "complete" });

describe("matchPlanToApply", () => {
  const PLAN = plan([
    planned("a.create", ["create"]),
    planned("a.update", ["update"]),
    planned("a.delete", ["delete"]),
    planned("a.replace", ["delete", "create"]),
    planned("a.cbd", ["create", "delete"]),
    planned("a.same", ["no-op"]),
    planned("data.a.read", ["read"]),
  ]);

  it("matches an apply that did exactly what the plan said, ignoring reads and no-ops", () => {
    const match = matchPlanToApply(
      PLAN,
      apply([
        done("a.create", "create"),
        done("a.update", "update"),
        done("a.delete", "delete"),
        done("a.replace", "replace"),
        done("a.cbd", "replace"),
        done("data.a.read", "read"),
      ])
    );
    expect(isExactMatch(match)).toBe(true);
    expect(match.complete).toBe(true);
  });

  it("reports changes the plan didn't list, planned changes not applied, and different actions", () => {
    const match = matchPlanToApply(
      PLAN,
      apply([done("a.create", "create"), done("a.update", "replace"), done("a.surprise", "delete"), done("a.replace", "replace"), done("a.cbd", "replace")])
    );
    expect(match.unplanned).toEqual(["a.surprise"]);
    expect(match.notApplied).toEqual(["a.delete"]);
    expect(match.differentAction).toEqual([{ address: "a.update", planned: "update", applied: "replace" }]);
    expect(isExactMatch(match)).toBe(false);
  });

  it("doesn't count what a failed apply never reached as missing", () => {
    const match = matchPlanToApply(PLAN, apply([done("a.create", "create")], "failed"));
    expect(match.notApplied).toEqual([]);
    expect(isExactMatch(match)).toBe(true);
  });

  it("marks the comparison incomplete when either digest was truncated", () => {
    expect(matchPlanToApply(plan([], true), apply([])).complete).toBe(false);
    expect(matchPlanToApply(plan([]), apply([], "succeeded", true)).complete).toBe(false);
  });
});

describe("pairAppliesWithPlans", () => {
  it("pairs each apply with the one plan of the same name", () => {
    const pairs = pairAppliesWithPlans(
      [{ id: "p1", name: "prod" }, { id: "p2", name: "test" }],
      [{ id: "a1", name: "prod" }, { id: "a2", name: "dev" }]
    );
    expect([...pairs.entries()]).toEqual([["a1", { id: "p1", name: "prod" }]]);
  });

  it("pairs nothing for a name that more than one plan or apply uses", () => {
    expect(pairAppliesWithPlans([{ id: "p1", name: "x" }, { id: "p2", name: "x" }], [{ id: "a1", name: "x" }]).size).toBe(0);
    expect(pairAppliesWithPlans([{ id: "p1", name: "x" }], [{ id: "a1", name: "x" }, { id: "a2", name: "x" }]).size).toBe(0);
  });
});
