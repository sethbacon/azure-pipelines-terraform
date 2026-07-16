/**
 * Terraform Tab — Azure DevOps Pipeline Build Results Tab
 *
 * Displays structured plan/apply/state digests (Plan/Apply/State pivots)
 * published as pipeline attachments, with a raw ANSI fallback for legacy
 * attachments and for any digest that fails to parse. Uses the standard
 * Azure DevOps Extension SDK pattern: SDK.init() -> SDK.ready() ->
 * config.onBuildChanged() -> BuildRestClient.getAttachments().
 *
 * The State pivot (Phase 5, digest spec §7.2) renders a `terraform-state-summary`
 * attachment's resource inventory. A destroy plan (`PlanDigest.planMode ===
 * "destroy"`, digest spec §7.1) reuses the Plan pivot unchanged and is only
 * LABELED with a "Destroy" badge in the overview row and detail header.
 *
 * Architecture informed by studying:
 *   - jason-johnson/azure-pipelines-tasks-terraform (MIT, Copyright 2021 Charles Zipp, 2023 Jason Johnson)
 *   - JaydenMaalouf/azure-pipelines-terraform-output (MIT, Copyright Microsoft Corporation)
 * See THIRD_PARTY_NOTICES.md for full attribution.
 * No code was copied from either project. All implementation below is original.
 *
 * SECURITY: this component (and every component it composes, other than
 * RawView) renders every digest value as a React text node — never via
 * `dangerouslySetInnerHTML` — per design §5.3/§8.1. `digest-model.ts` is the
 * only place raw fetched JSON is parsed; nothing here ever spreads an
 * untrusted parsed object into state or props.
 */

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import * as SDK from "azure-devops-extension-sdk";
import { Build, BuildRestClient } from "azure-devops-extension-api/Build";
import { getClient } from "azure-devops-extension-api";
import { parseDigestText } from "./digest-model";
import { Digest, PlanResource } from "./digest-schema";
import { TAB_MAX_RENDERED_ROWS, TAB_PARSE_CEILING_BYTES } from "./caps";
import { SummaryHeader, SummaryHeaderCounts, SummaryHeaderStateCounts } from "./components/SummaryHeader";
import { OverviewList, OverviewItem } from "./components/OverviewList";
import { ResourceList } from "./components/ResourceList";
import { ResourceDiff } from "./components/ResourceDiff";
import { ApplyTimeline } from "./components/ApplyTimeline";
import { OutputsPanel } from "./components/OutputsPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { StateInventory } from "./components/StateInventory";
import { RawView } from "./components/RawView";
import "./tabContent.css";

/** New structured attachment types (§7 of the design doc), additive to the legacy raw attachment. */
const PLAN_SUMMARY_ATTACHMENT_TYPE = "terraform-plan-summary";
const APPLY_SUMMARY_ATTACHMENT_TYPE = "terraform-apply-summary";
/** State-inventory attachment type (Phase 5, digest spec §7.2), additive alongside plan/apply. */
const STATE_SUMMARY_ATTACHMENT_TYPE = "terraform-state-summary";
/** Legacy raw attachment type, kept for backward compatibility (jason-johnson migration convention). */
const LEGACY_RAW_ATTACHMENT_TYPE = "terraform-plan-results";

interface AttachmentRef {
    name: string;
    _links: { self: { href: string } };
}

interface RawAttachment {
    name: string;
    content: string;
}

/** A single published plan/apply digest attachment, after fetch + safe parse. `raw` is always the fetched body (used for the raw-fallback view and download). */
type DigestItem =
    | { id: string; name: string; status: "ok"; digest: Digest; unknownVersion: boolean; notes: string[]; raw: RawAttachment }
    | { id: string; name: string; status: "error"; message: string; raw: RawAttachment };

interface TerraformTabState {
    loading: boolean;
    error: string | null;
    activePivot: "plan" | "apply" | "state";
    planItems: DigestItem[];
    applyItems: DigestItem[];
    stateItems: DigestItem[];
    legacyRaw: RawAttachment[];
    selectedPlanId: string | null;
    selectedApplyId: string | null;
    selectedStateId: string | null;
    selectedLegacyIndex: number;
    selectedResourceAddress: string | null;
    resourceSearchText: string;
    selectedStateAddress: string | null;
    stateSearchText: string;
}

function byNameCaseInsensitive<T extends { name: string }>(a: T, b: T): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Adapts a DriftResource (no `actions`/`actionReason`/`replacePaths`) into the PlanResource shape ResourceDiff renders. */
function driftAsPlanResource(drift: NonNullable<Extract<Digest, { kind: "plan" }>["drift"]>[number]): PlanResource {
    return { ...drift, actions: [] };
}

export class TerraformPlanTab extends React.Component<{}, TerraformTabState> {
    constructor(props: {}) {
        super(props);
        this.state = {
            loading: true,
            error: null,
            activePivot: "plan",
            planItems: [],
            applyItems: [],
            stateItems: [],
            legacyRaw: [],
            selectedPlanId: null,
            selectedApplyId: null,
            selectedStateId: null,
            selectedLegacyIndex: 0,
            selectedResourceAddress: null,
            resourceSearchText: "",
            selectedStateAddress: null,
            stateSearchText: "",
        };
    }

    public render(): JSX.Element {
        const { loading, error } = this.state;

        if (loading) {
            return <div className="plan-loading">Loading terraform results...</div>;
        }

        if (error) {
            return <div className="plan-empty">Error: {error}</div>;
        }

        const { planItems, applyItems, stateItems, legacyRaw } = this.state;
        if (planItems.length === 0 && applyItems.length === 0 && stateItems.length === 0 && legacyRaw.length === 0) {
            return (
                <div className="plan-empty">
                    No terraform plans, applies, or state have been published for this pipeline run.
                    <br />
                    <br />
                    Set <code>publishPlanResults</code>, <code>publishPlanSummary</code>, or{" "}
                    <code>publishApplyResults</code> on the terraform task to publish results here.
                </div>
            );
        }

        return (
            <div className="terraform-container">
                <div className="pivot-bar" role="tablist">
                    <button
                        role="tab"
                        aria-selected={this.state.activePivot === "plan"}
                        className={`pivot-tab${this.state.activePivot === "plan" ? " active" : ""}`}
                        onClick={() => this.setActivePivot("plan")}
                    >
                        Plan
                    </button>
                    <button
                        role="tab"
                        aria-selected={this.state.activePivot === "apply"}
                        className={`pivot-tab${this.state.activePivot === "apply" ? " active" : ""}`}
                        onClick={() => this.setActivePivot("apply")}
                    >
                        Apply
                    </button>
                    <button
                        role="tab"
                        aria-selected={this.state.activePivot === "state"}
                        className={`pivot-tab${this.state.activePivot === "state" ? " active" : ""}`}
                        onClick={() => this.setActivePivot("state")}
                    >
                        State
                    </button>
                </div>
                {this.state.activePivot === "plan" && this.renderPlanPivot()}
                {this.state.activePivot === "apply" && this.renderApplyPivot()}
                {this.state.activePivot === "state" && this.renderStatePivot()}
            </div>
        );
    }

    private renderPlanPivot(): JSX.Element {
        const { planItems, legacyRaw, selectedPlanId } = this.state;

        if (planItems.length === 0) {
            if (legacyRaw.length === 0) {
                return <div className="plan-empty">No terraform plans have been published for this pipeline run.</div>;
            }
            return this.renderLegacyRawFallback();
        }

        const okItems = planItems.filter((i): i is Extract<DigestItem, { status: "ok" }> => i.status === "ok");
        const rollup = aggregatePlanRollup(okItems);
        const overviewItems: OverviewItem[] = planItems.map(toPlanOverviewItem);
        const selected = planItems.find((i) => i.id === selectedPlanId) ?? planItems[0];

        return (
            <div className="pivot-panel">
                {planItems.length > 1 && (
                    <SummaryHeader
                        title={`All plans (${planItems.length})`}
                        kind="plan"
                        counts={rollup.counts}
                        noChanges={rollup.noChanges}
                        driftDetected={rollup.driftDetected}
                    />
                )}
                {planItems.length > 1 && (
                    <OverviewList items={overviewItems} selectedId={selectedPlanId} onSelect={this.onSelectPlan} />
                )}
                {selected && this.renderPlanDetail(selected)}
            </div>
        );
    }

    private renderPlanDetail(item: DigestItem): JSX.Element {
        if (item.status === "error") {
            return this.renderDigestError(item);
        }
        if (item.digest.kind !== "plan") {
            return this.renderDigestError({ message: "Unexpected digest kind.", raw: item.raw, name: item.name });
        }
        const digest = item.digest;
        const { selectedResourceAddress, resourceSearchText } = this.state;
        const selectedResource = digest.resources.find((r) => r.address === selectedResourceAddress) ?? null;

        return (
            <div className="digest-detail">
                {item.unknownVersion && <div className="unknown-version-banner">{item.notes.join(" ")}</div>}
                <SummaryHeader
                    title={item.name}
                    kind="plan"
                    counts={digest.summary}
                    noChanges={digest.summary.noChanges}
                    driftDetected={digest.summary.driftDetected}
                    destroyMode={digest.planMode === "destroy"}
                    truncated={digest.truncated}
                    truncationNotes={digest.truncationNotes}
                    toolLabel={`${digest.tool.name} ${digest.tool.version}`}
                />
                <ResourceList
                    resources={digest.resources}
                    selectedAddress={selectedResourceAddress}
                    onSelect={this.onSelectResource}
                    searchText={resourceSearchText}
                    onSearchTextChange={this.onResourceSearchChange}
                />
                {selectedResource && <ResourceDiff resource={selectedResource} />}
                {digest.drift && digest.drift.length > 0 && (
                    <div className="drift-section">
                        <h3>Drift detected</h3>
                        {digest.drift.length > TAB_MAX_RENDERED_ROWS && (
                            <div className="drift-section-truncated-banner">
                                List truncated to {TAB_MAX_RENDERED_ROWS} of {digest.drift.length} drifted resources.
                            </div>
                        )}
                        {digest.drift.slice(0, TAB_MAX_RENDERED_ROWS).map((d) => (
                            <ResourceDiff key={d.address} resource={driftAsPlanResource(d)} />
                        ))}
                    </div>
                )}
                <OutputsPanel outputs={digest.outputChanges} />
                {this.renderRawDetails(item.raw)}
            </div>
        );
    }

    private renderApplyPivot(): JSX.Element {
        const { applyItems, selectedApplyId } = this.state;

        if (applyItems.length === 0) {
            return (
                <div className="plan-empty">No terraform apply results have been published for this pipeline run.</div>
            );
        }

        const okItems = applyItems.filter((i): i is Extract<DigestItem, { status: "ok" }> => i.status === "ok");
        const rollup = aggregateApplyRollup(okItems);
        const overviewItems: OverviewItem[] = applyItems.map(toApplyOverviewItem);
        const selected = applyItems.find((i) => i.id === selectedApplyId) ?? applyItems[0];

        return (
            <div className="pivot-panel">
                {applyItems.length > 1 && (
                    <SummaryHeader title={`All applies (${applyItems.length})`} kind="apply" counts={rollup.counts} />
                )}
                {applyItems.length > 1 && (
                    <OverviewList items={overviewItems} selectedId={selectedApplyId} onSelect={this.onSelectApply} />
                )}
                {selected && this.renderApplyDetail(selected)}
            </div>
        );
    }

    private renderApplyDetail(item: DigestItem): JSX.Element {
        if (item.status === "error") {
            return this.renderDigestError(item);
        }
        if (item.digest.kind !== "apply") {
            return this.renderDigestError({ message: "Unexpected digest kind.", raw: item.raw, name: item.name });
        }
        const digest = item.digest;

        return (
            <div className="digest-detail">
                {item.unknownVersion && <div className="unknown-version-banner">{item.notes.join(" ")}</div>}
                <SummaryHeader
                    title={item.name}
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
                {this.renderRawDetails(item.raw)}
            </div>
        );
    }

    private renderStatePivot(): JSX.Element {
        const { stateItems, selectedStateId } = this.state;

        if (stateItems.length === 0) {
            return <div className="plan-empty">No terraform state has been published for this pipeline run.</div>;
        }

        const okItems = stateItems.filter((i): i is Extract<DigestItem, { status: "ok" }> => i.status === "ok");
        const rollup = aggregateStateRollup(okItems);
        const overviewItems: OverviewItem[] = stateItems.map(toStateOverviewItem);
        const selected = stateItems.find((i) => i.id === selectedStateId) ?? stateItems[0];

        return (
            <div className="pivot-panel">
                {stateItems.length > 1 && (
                    <SummaryHeader title={`All state (${stateItems.length})`} kind="state" stateCounts={rollup} />
                )}
                {stateItems.length > 1 && (
                    <OverviewList items={overviewItems} selectedId={selectedStateId} onSelect={this.onSelectState} />
                )}
                {selected && this.renderStateDetail(selected)}
            </div>
        );
    }

    private renderStateDetail(item: DigestItem): JSX.Element {
        if (item.status === "error") {
            return this.renderDigestError(item);
        }
        if (item.digest.kind !== "state") {
            return this.renderDigestError({ message: "Unexpected digest kind.", raw: item.raw, name: item.name });
        }
        const digest = item.digest;
        const { selectedStateAddress, stateSearchText } = this.state;

        return (
            <div className="digest-detail">
                {item.unknownVersion && <div className="unknown-version-banner">{item.notes.join(" ")}</div>}
                <SummaryHeader
                    title={item.name}
                    kind="state"
                    stateCounts={digest.summary}
                    truncated={digest.truncated}
                    truncationNotes={digest.truncationNotes}
                    toolLabel={`${digest.tool.name} ${digest.tool.version}`}
                />
                <StateInventory
                    resources={digest.resources}
                    selectedAddress={selectedStateAddress}
                    onSelect={this.onSelectStateResource}
                    searchText={stateSearchText}
                    onSearchTextChange={this.onStateSearchTextChange}
                />
                <OutputsPanel outputs={digest.outputs} />
                {this.renderRawDetails(item.raw)}
            </div>
        );
    }

    private renderDigestError(item: { message: string; raw: RawAttachment; name: string }): JSX.Element {
        return (
            <div className="digest-parse-error">
                <p>
                    Could not render structured results for <strong>{item.name}</strong>: {item.message}
                </p>
                <RawView name={item.raw.name} content={item.raw.content} />
            </div>
        );
    }

    private renderRawDetails(raw: RawAttachment): JSX.Element {
        return (
            <details className="raw-details">
                <summary>View raw digest</summary>
                <RawView name={raw.name} content={raw.content} />
            </details>
        );
    }

    private renderLegacyRawFallback(): JSX.Element {
        const { legacyRaw, selectedLegacyIndex } = this.state;
        const selected = legacyRaw[selectedLegacyIndex] ?? legacyRaw[0];

        return (
            <div className="pivot-panel">
                {legacyRaw.length > 1 && (
                    <div className="plan-header">
                        <label htmlFor="legacy-plan-select">Plan:</label>
                        <select
                            id="legacy-plan-select"
                            className="plan-select"
                            value={selectedLegacyIndex}
                            onChange={this.onSelectLegacy}
                        >
                            {legacyRaw.map((plan, i) => (
                                <option key={plan.name} value={i}>
                                    {plan.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                {legacyRaw.length === 1 && (
                    <div className="plan-header">
                        <strong>{selected.name}</strong>
                    </div>
                )}
                {selected && <RawView name={selected.name} content={selected.content} />}
            </div>
        );
    }

    private setActivePivot = (pivot: "plan" | "apply" | "state"): void => {
        this.setState({ activePivot: pivot });
    };

    private onSelectPlan = (id: string): void => {
        this.setState({ selectedPlanId: id, selectedResourceAddress: null, resourceSearchText: "" });
    };

    private onSelectApply = (id: string): void => {
        this.setState({ selectedApplyId: id });
    };

    private onSelectState = (id: string): void => {
        this.setState({ selectedStateId: id, selectedStateAddress: null, stateSearchText: "" });
    };

    private onSelectResource = (address: string): void => {
        this.setState((prev: TerraformTabState) => ({
            selectedResourceAddress: prev.selectedResourceAddress === address ? null : address,
        }));
    };

    private onResourceSearchChange = (text: string): void => {
        this.setState({ resourceSearchText: text });
    };

    private onSelectStateResource = (address: string): void => {
        this.setState((prev: TerraformTabState) => ({
            selectedStateAddress: prev.selectedStateAddress === address ? null : address,
        }));
    };

    private onStateSearchTextChange = (text: string): void => {
        this.setState({ stateSearchText: text });
    };

    private onSelectLegacy = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        this.setState({ selectedLegacyIndex: parseInt(event.target.value, 10) });
    };

    /** Fetch an attachment's body, parse it as a plan/apply digest, and classify it as ok/error. Non-OK HTTP responses and network failures are skipped (logged), matching the legacy loader's behavior. */
    private async loadDigestItems(
        attachments: AttachmentRef[],
        authHeader: string,
        expectedKind: "plan" | "apply" | "state"
    ): Promise<DigestItem[]> {
        const items: DigestItem[] = [];
        for (let i = 0; i < attachments.length; i++) {
            const attachment = attachments[i];
            const id = `${attachment.name}#${i}`;
            try {
                const response = await fetch(attachment._links.self.href, { headers: { Authorization: authHeader } });
                if (!response.ok) continue;
                const contentLengthHeader = response.headers.get("content-length");
                const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
                const byteLength = Number.isFinite(parsedLength) ? parsedLength : undefined;

                // Guard the body size BEFORE buffering it: a declared Content-Length
                // over the parse ceiling means we refuse to read the (potentially
                // multi-MB) body into memory at all — reading it first would be the
                // very OOM the ceiling exists to prevent. Without a declared length we
                // fall through and let parseDigestText enforce the ceiling post-read.
                if (byteLength !== undefined && byteLength > TAB_PARSE_CEILING_BYTES) {
                    items.push({
                        id,
                        name: attachment.name,
                        status: "error",
                        message: `Digest is ${byteLength} bytes, over the ${TAB_PARSE_CEILING_BYTES}-byte tab parse ceiling; not loaded. Download it from the build artifacts instead.`,
                        raw: { name: attachment.name, content: "" },
                    });
                    continue;
                }

                const content = await response.text();
                const raw: RawAttachment = { name: attachment.name, content };

                const parsed = parseDigestText(content, byteLength);
                if (parsed.ok && parsed.digest.kind === expectedKind) {
                    items.push({
                        id,
                        name: attachment.name,
                        status: "ok",
                        digest: parsed.digest,
                        unknownVersion: parsed.unknownVersion,
                        notes: parsed.notes,
                        raw,
                    });
                } else if (parsed.ok) {
                    items.push({
                        id,
                        name: attachment.name,
                        status: "error",
                        message: `Digest kind "${parsed.digest.kind}" does not match the expected "${expectedKind}" attachment type.`,
                        raw,
                    });
                } else {
                    items.push({ id, name: attachment.name, status: "error", message: parsed.message, raw });
                }
            } catch (err) {
                console.error(`Failed to download attachment ${attachment.name}:`, err);
            }
        }
        return items;
    }

    private async loadRawAttachments(attachments: AttachmentRef[], authHeader: string): Promise<RawAttachment[]> {
        const items: RawAttachment[] = [];
        for (const attachment of attachments) {
            try {
                const response = await fetch(attachment._links.self.href, { headers: { Authorization: authHeader } });
                if (response.ok) {
                    const content = await response.text();
                    items.push({ name: attachment.name, content });
                }
            } catch (err) {
                console.error(`Failed to download attachment ${attachment.name}:`, err);
            }
        }
        return items;
    }

    public async loadAll(build: Build): Promise<void> {
        try {
            const buildClient = getClient(BuildRestClient);
            const accessToken = await SDK.getAccessToken();
            const authHeader = "Basic " + btoa(":" + accessToken);

            const [planAttachments, applyAttachments, stateAttachments, legacyAttachments] = await Promise.all([
                buildClient.getAttachments(build.project.id, build.id, PLAN_SUMMARY_ATTACHMENT_TYPE),
                buildClient.getAttachments(build.project.id, build.id, APPLY_SUMMARY_ATTACHMENT_TYPE),
                buildClient.getAttachments(build.project.id, build.id, STATE_SUMMARY_ATTACHMENT_TYPE),
                buildClient.getAttachments(build.project.id, build.id, LEGACY_RAW_ATTACHMENT_TYPE),
            ]);

            const [planItems, applyItems, stateItems, legacyRaw] = await Promise.all([
                this.loadDigestItems(planAttachments ?? [], authHeader, "plan"),
                this.loadDigestItems(applyAttachments ?? [], authHeader, "apply"),
                this.loadDigestItems(stateAttachments ?? [], authHeader, "state"),
                this.loadRawAttachments(legacyAttachments ?? [], authHeader),
            ]);

            planItems.sort(byNameCaseInsensitive);
            applyItems.sort(byNameCaseInsensitive);
            stateItems.sort(byNameCaseInsensitive);
            legacyRaw.sort(byNameCaseInsensitive);

            const activePivot =
                planItems.length === 0 && legacyRaw.length === 0 && applyItems.length === 0 && stateItems.length > 0
                    ? "state"
                    : planItems.length === 0 && legacyRaw.length === 0 && applyItems.length > 0
                    ? "apply"
                    : "plan";

            this.setState({
                planItems,
                applyItems,
                stateItems,
                legacyRaw,
                selectedPlanId: planItems[0]?.id ?? null,
                selectedApplyId: applyItems[0]?.id ?? null,
                selectedStateId: stateItems[0]?.id ?? null,
                selectedLegacyIndex: 0,
                selectedResourceAddress: null,
                resourceSearchText: "",
                selectedStateAddress: null,
                stateSearchText: "",
                activePivot,
                loading: false,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setState({ error: message, loading: false });
        }
    }
}

function toPlanOverviewItem(item: DigestItem): OverviewItem {
    if (item.status === "error" || item.digest.kind !== "plan") {
        return { id: item.id, name: item.name, status: "error", message: item.status === "error" ? item.message : "Unexpected digest kind." };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        counts: { add: s.add, change: s.change, destroy: s.destroy, replace: s.replace, read: s.read },
        noChanges: s.noChanges,
        driftDetected: s.driftDetected,
        destroyMode: item.digest.planMode === "destroy",
    };
}

function toApplyOverviewItem(item: DigestItem): OverviewItem {
    if (item.status === "error" || item.digest.kind !== "apply") {
        return { id: item.id, name: item.name, status: "error", message: item.status === "error" ? item.message : "Unexpected digest kind." };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        counts: { add: s.add, change: s.change, destroy: s.destroy },
        outcome: item.digest.outcome,
    };
}

interface PlanRollup {
    counts: SummaryHeaderCounts;
    noChanges: boolean;
    driftDetected: boolean;
}

function aggregatePlanRollup(items: Array<Extract<DigestItem, { status: "ok" }>>): PlanRollup {
    const rollup: PlanRollup = { counts: { add: 0, change: 0, destroy: 0, replace: 0, read: 0 }, noChanges: items.length > 0, driftDetected: false };
    for (const item of items) {
        if (item.digest.kind !== "plan") continue;
        const s = item.digest.summary;
        rollup.counts.add += s.add;
        rollup.counts.change += s.change;
        rollup.counts.destroy += s.destroy;
        rollup.counts.replace = (rollup.counts.replace ?? 0) + s.replace;
        rollup.counts.read = (rollup.counts.read ?? 0) + s.read;
        rollup.noChanges = rollup.noChanges && s.noChanges;
        rollup.driftDetected = rollup.driftDetected || s.driftDetected;
    }
    return rollup;
}

interface ApplyRollup {
    counts: SummaryHeaderCounts;
}

function aggregateApplyRollup(items: Array<Extract<DigestItem, { status: "ok" }>>): ApplyRollup {
    const counts: SummaryHeaderCounts = { add: 0, change: 0, destroy: 0 };
    for (const item of items) {
        if (item.digest.kind !== "apply") continue;
        const s = item.digest.summary;
        counts.add += s.add;
        counts.change += s.change;
        counts.destroy += s.destroy;
    }
    return { counts };
}

function toStateOverviewItem(item: DigestItem): OverviewItem {
    if (item.status === "error" || item.digest.kind !== "state") {
        return { id: item.id, name: item.name, status: "error", message: item.status === "error" ? item.message : "Unexpected digest kind." };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        stateCounts: { resourceCount: s.resourceCount, dataSourceCount: s.dataSourceCount },
    };
}

function aggregateStateRollup(items: Array<Extract<DigestItem, { status: "ok" }>>): SummaryHeaderStateCounts {
    const counts: SummaryHeaderStateCounts = { resourceCount: 0, dataSourceCount: 0 };
    for (const item of items) {
        if (item.digest.kind !== "state") continue;
        const s = item.digest.summary;
        counts.resourceCount += s.resourceCount;
        counts.dataSourceCount += s.dataSourceCount;
    }
    return counts;
}

// Initialize the Azure DevOps Extension SDK and render the tab
SDK.init();

SDK.ready().then(() => {
    const config = SDK.getConfiguration();
    const container = document.getElementById("terraform-container");

    if (!container) {
        console.error("Container element not found");
        return;
    }

    if (typeof config.onBuildChanged === "function") {
        const tabRef = React.createRef<TerraformPlanTab>();
        const root = ReactDOM.createRoot(container);

        root.render(<TerraformPlanTab ref={tabRef} />);

        config.onBuildChanged((build: Build) => {
            if (tabRef.current) {
                tabRef.current.loadAll(build);
            }
        });
    } else {
        const root = ReactDOM.createRoot(container);
        root.render(
            <div className="plan-empty">
                This tab is only available in build pipeline results.
            </div>
        );
    }
}).catch((err) => {
    console.error("Failed to initialize Azure DevOps Extension SDK:", err);
});
