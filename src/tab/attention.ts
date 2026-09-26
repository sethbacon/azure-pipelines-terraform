import { Digest } from "./digest-schema";

/** The tab's three pivots. */
export type Pivot = "plan" | "apply" | "state";

/**
 * The part of a loaded digest item this module reads. Structural, so
 * tabContent's `DigestItem` union (ok items carry `digest`, error items don't)
 * is assignable to it as-is.
 */
export interface AttentionSource {
    id: string;
    name: string;
    status: "ok" | "error";
    digest?: Digest;
    /** Present when the build timeline identified the step that published the item. */
    origin?: { fromTerraformTask: boolean };
}

export type AttentionSeverity = "critical" | "warning";

/** One digest item a reviewer should look at before approving. */
export interface AttentionItem {
    pivot: Pivot;
    id: string;
    /** Untrusted attachment name — render as a text node only. */
    name: string;
    severity: AttentionSeverity;
    /** Built only from counts and fixed wording, never from digest text. */
    reason: string;
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * How much a plan needs review, lower first: anything that destroys, then a
 * digest that can't be read or is incomplete (what it hides is unknown), then
 * drift, then any other change, then no changes.
 */
export function planRisk(item: AttentionSource): number {
    if (item.status !== "ok" || item.digest?.kind !== "plan") return 1;
    const digest = item.digest;
    if (digest.planMode === "destroy" || digest.summary.destroy > 0) return 0;
    if (digest.truncated) return 1;
    if (digest.summary.driftDetected) return 2;
    return digest.summary.noChanges ? 4 : 3;
}

/** Whether the item is a readable apply digest whose apply failed. */
export function isFailedApply(item: AttentionSource): boolean {
    return item.status === "ok" && item.digest?.kind === "apply" && item.digest.outcome === "failed";
}

/** How much an apply needs review, lower first: failed, then unreadable, then incomplete, then the rest. */
export function applyRisk(item: AttentionSource): number {
    if (isFailedApply(item)) return 0;
    if (item.status !== "ok" || item.digest?.kind !== "apply") return 1;
    return item.digest.truncated ? 2 : 3;
}

/** The first item with the lowest risk, so ties keep the list's own order; null for an empty list. */
export function riskiestId<T extends AttentionSource>(items: T[], risk: (item: T) => number): string | null {
    let best: T | null = null;
    let bestRisk = Infinity;
    for (const item of items) {
        const r = risk(item);
        if (r < bestRisk) {
            best = item;
            bestRisk = r;
        }
    }
    return best?.id ?? null;
}

function planReasons(item: AttentionSource): { severity: AttentionSeverity; reasons: string[] } {
    if (item.status !== "ok" || item.digest?.kind !== "plan") return { severity: "warning", reasons: ["couldn't be read"] };
    const { summary, planMode, drift, truncated } = item.digest;
    const reasons: string[] = [];
    let severity: AttentionSeverity = "warning";
    if (planMode === "destroy" || summary.destroy > 0) {
        severity = "critical";
        const destroys = `${summary.destroy} to destroy${summary.replace > 0 ? ` (${summary.replace} replaced)` : ""}`;
        reasons.push(planMode === "destroy" ? `destroy plan, ${destroys}` : destroys);
    }
    if (summary.driftDetected) {
        reasons.push(drift && drift.length > 0 ? `drift on ${plural(drift.length, "resource", "resources")}` : "drift detected");
    }
    if (truncated) reasons.push("partial view (truncated)");
    return { severity, reasons };
}

function applyReasons(item: AttentionSource): { severity: AttentionSeverity; reasons: string[] } {
    if (item.status !== "ok" || item.digest?.kind !== "apply") return { severity: "warning", reasons: ["couldn't be read"] };
    const { outcome, diagnostics, truncated } = item.digest;
    const reasons: string[] = [];
    let severity: AttentionSeverity = "warning";
    if (outcome === "failed") {
        severity = "critical";
        const errors = diagnostics.filter((d) => d.severity === "error").length;
        reasons.push(errors > 0 ? `apply failed with ${plural(errors, "error", "errors")}` : "apply failed");
    }
    if (truncated) reasons.push("partial view (truncated)");
    return { severity, reasons };
}

function stateReasons(item: AttentionSource): { severity: AttentionSeverity; reasons: string[] } {
    if (item.status !== "ok" || item.digest?.kind !== "state") return { severity: "warning", reasons: ["couldn't be read"] };
    return { severity: "warning", reasons: item.digest.truncated ? ["partial view (truncated)"] : [] };
}

/**
 * Everything across the run that deserves a look before approving: failed
 * applies, plans that destroy, digests that can't be read or are incomplete,
 * drift, and digests a step other than the Terraform task published. One entry
 * per digest item, critical ones first, otherwise in pivot and list order.
 */
export function collectAttention(
    plans: AttentionSource[],
    applies: AttentionSource[],
    states: AttentionSource[]
): AttentionItem[] {
    const items: AttentionItem[] = [];
    const add = (pivot: Pivot, source: AttentionSource, found: { severity: AttentionSeverity; reasons: string[] }): void => {
        const reasons = [...found.reasons];
        if (source.origin && !source.origin.fromTerraformTask) reasons.push("published by a step that isn't the Terraform task");
        if (reasons.length === 0) return;
        items.push({ pivot, id: source.id, name: source.name, severity: found.severity, reason: reasons.join(" · ") });
    };
    for (const apply of applies) add("apply", apply, applyReasons(apply));
    for (const plan of plans) add("plan", plan, planReasons(plan));
    for (const state of states) add("state", state, stateReasons(state));
    const rank = (severity: AttentionSeverity): number => (severity === "critical" ? 0 : 1);
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item.severity) - rank(b.item.severity) || a.index - b.index)
        .map(({ item }) => item);
}
