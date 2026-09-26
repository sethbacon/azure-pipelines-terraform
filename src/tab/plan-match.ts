import { ApplyDigest, PlanDigest, PlanResource } from "./digest-schema";

/**
 * Did an apply do what its plan said?
 *
 * Within one run, a plan and an apply published under the same name are
 * compared resource by resource. An apply that ran from the saved plan should
 * match it (short of a failure part-way). One that planned again at apply
 * time can differ — that difference is what a reviewer who approved the plan
 * needs to see. Only the current run's digests are compared; nothing is fetched.
 */

/** The action a resource change amounts to, in the apply digest's vocabulary. */
type ChangeAction = "create" | "update" | "delete" | "replace";

export interface PlanMatch {
    /** Addresses the apply changed that the plan didn't list as changing. */
    unplanned: string[];
    /** Addresses the plan listed as changing that the apply didn't touch. */
    notApplied: string[];
    /** Addresses both changed, but not in the same way. */
    differentAction: Array<{ address: string; planned: ChangeAction; applied: ChangeAction }>;
    /** False when either digest was truncated, so a difference may just be a capped list. */
    complete: boolean;
}

function plannedAction(resource: PlanResource): ChangeAction | null {
    const { actions } = resource;
    if (actions.includes("replace") || (actions.includes("delete") && actions.includes("create"))) return "replace";
    if (actions.includes("create")) return "create";
    if (actions.includes("delete")) return "delete";
    if (actions.includes("update")) return "update";
    return null; // no-op, read, forget: nothing an apply reports as a change
}

/** Compares an apply with the plan it should have carried out. */
export function matchPlanToApply(plan: PlanDigest, apply: ApplyDigest): PlanMatch {
    const planned = new Map<string, ChangeAction>();
    for (const resource of plan.resources) {
        const action = plannedAction(resource);
        if (action) planned.set(resource.address, action);
    }
    const applied = new Map<string, ChangeAction>();
    for (const resource of apply.resources) {
        if (resource.action !== "read") applied.set(resource.address, resource.action);
    }

    const unplanned: string[] = [];
    const differentAction: PlanMatch["differentAction"] = [];
    for (const [address, action] of applied) {
        const expected = planned.get(address);
        if (expected === undefined) unplanned.push(address);
        else if (expected !== action) differentAction.push({ address, planned: expected, applied: action });
    }
    // On a failed apply, whatever wasn't reached is expected to be missing.
    const notApplied = apply.outcome === "failed" ? [] : [...planned.keys()].filter((address) => !applied.has(address));

    return { unplanned, notApplied, differentAction, complete: !plan.truncated && !apply.truncated };
}

/** Whether nothing differs. */
export function isExactMatch(match: PlanMatch): boolean {
    return match.unplanned.length === 0 && match.notApplied.length === 0 && match.differentAction.length === 0;
}

/**
 * The plan each apply should be compared with: the plan published under the
 * same name. When a name is used by more than one plan (or apply), there is no
 * single counterpart and nothing is paired for it.
 */
export function pairAppliesWithPlans<P extends { name: string }, A extends { id: string; name: string }>(
    plans: P[],
    applies: A[]
): Map<string, P> {
    const plansByName = new Map<string, P[]>();
    for (const plan of plans) plansByName.set(plan.name, [...(plansByName.get(plan.name) ?? []), plan]);
    const appliesPerName = new Map<string, number>();
    for (const apply of applies) appliesPerName.set(apply.name, (appliesPerName.get(apply.name) ?? 0) + 1);

    const pairs = new Map<string, P>();
    for (const apply of applies) {
        const candidates = plansByName.get(apply.name) ?? [];
        if (candidates.length === 1 && appliesPerName.get(apply.name) === 1) pairs.set(apply.id, candidates[0]);
    }
    return pairs;
}
