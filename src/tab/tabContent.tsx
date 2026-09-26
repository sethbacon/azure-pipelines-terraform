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
 * SECURITY: this component (and every component it composes) renders every
 * digest value as a React text node — never via `dangerouslySetInnerHTML` —
 * per design §5.3/§8.1; that includes the raw digest views, which use
 * RawView's "text" format. RawView's "ansi" format, the tab's one HTML sink,
 * is only ever given legacy `terraform-plan-results` output. `digest-model.ts`
 * is the only place raw fetched JSON is parsed; nothing here ever spreads an
 * untrusted parsed object into state or props.
 */

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import * as SDK from "azure-devops-extension-sdk";
import { Build, BuildRestClient } from "azure-devops-extension-api/Build";
import { getClient } from "azure-devops-extension-api";
import { parseDigestText } from "./digest-model";
import { Diagnostic, Digest, OutputChange } from "./digest-schema";
import { TAB_PARSE_CEILING_BYTES } from "./caps";
import { memoizeOne } from "./memoize";
import { mapWithConcurrency } from "./concurrency";
import { readBodyCapped } from "./read-body";
import { AttachmentOrigin, OriginLookup, TimelineRecordLike, buildOriginLookup, compareOrigins, formatOrigin } from "./origin";
import { Pivot, applyRisk, collectAttention, isFailedApply, planRisk, riskiestId } from "./attention";
import { AttentionStrip } from "./components/AttentionStrip";
import { SummaryHeader, SummaryHeaderCounts, SummaryHeaderStateCounts } from "./components/SummaryHeader";
import { OverviewList, OverviewItem, OverviewOrigin } from "./components/OverviewList";
import { ActionGroup, ResourceList, countChangedResources } from "./components/ResourceList";
import { DriftList } from "./components/DriftList";
import { ApplyTimeline } from "./components/ApplyTimeline";
import { OutputsPanel } from "./components/OutputsPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { StateInventory } from "./components/StateInventory";
import { Section } from "./components/Section";
import { RawView } from "./components/RawView";
import "./tabContent.css";

// The presentational components are memoized here, at the composition site,
// rather than in their own modules (whose unit tests call them as plain
// functions). Their props stay referentially stable across unrelated state
// changes — digest arrays come straight from state, the multi-item roll-ups are
// memoized per item array, and every handler is a class-bound arrow property —
// so typing in the resource search re-renders the resource list without
// re-rendering the summary, overview, drift, or outputs panels.
const MemoAttentionStrip = React.memo(AttentionStrip);
const MemoSummaryHeader = React.memo(SummaryHeader);
const MemoOverviewList = React.memo(OverviewList);
const MemoResourceList = React.memo(ResourceList);
const MemoDriftList = React.memo(DriftList);
const MemoApplyTimeline = React.memo(ApplyTimeline);
const MemoDiagnosticsPanel = React.memo(DiagnosticsPanel);
const MemoOutputsPanel = React.memo(OutputsPanel);
const MemoStateInventory = React.memo(StateInventory);

/** The fixed collapsible sections of the three detail views. */
type FixedSectionKey =
    | "plan.changes"
    | "plan.drift"
    | "plan.outputs"
    | "plan.cli"
    | "apply.resources"
    | "apply.diagnostics"
    | "apply.outputs"
    | "state.resources"
    | "state.outputs";

/**
 * Every collapsible section: the fixed ones, plus one per legacy CLI output
 * that no structured plan claims. The `cli:` prefix also keeps an attachment
 * name from ever being used as a bare object key (`__proto__` and friends).
 */
type SectionKey = FixedSectionKey | `cli:${string}`;

const DEFAULT_SECTION_OPEN: Record<FixedSectionKey, boolean> = {
    "plan.changes": true,
    // Collapsed until asked for: drift can run to thousands of attribute tables,
    // and the summary header's badge and this section's count already flag it.
    "plan.drift": false,
    "plan.outputs": true,
    // The structured view comes first; the CLI output is there for reference.
    "plan.cli": false,
    "apply.resources": true,
    "apply.diagnostics": true,
    "apply.outputs": true,
    "state.resources": true,
    "state.outputs": true,
};

function defaultSectionOpen(key: SectionKey): boolean {
    return key.startsWith("cli:") ? false : DEFAULT_SECTION_OPEN[key as FixedSectionKey];
}

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

/**
 * A single published plan/apply digest attachment, after fetch + safe parse. `raw` is always the fetched body (used for the
 * raw-fallback view and download). `origin` is where the build timeline says it was published, when that is known.
 */
type DigestItem = (
    | { id: string; name: string; status: "ok"; digest: Digest; unknownVersion: boolean; notes: string[]; raw: RawAttachment }
    | { id: string; name: string; status: "error"; message: string; raw: RawAttachment }
) & { origin?: AttachmentOrigin };

/** Attachment bodies downloaded at once: enough to overlap round trips, few enough not to flood the connection pool. */
const DOWNLOAD_CONCURRENCY = 4;

interface TerraformTabState {
    loading: boolean;
    error: string | null;
    activePivot: Pivot;
    planItems: DigestItem[];
    applyItems: DigestItem[];
    stateItems: DigestItem[];
    legacyRaw: RawAttachment[];
    /** The build the items above were loaded from; a reload of the same build keeps the user's selections. */
    loadedBuildId: number | null;
    selectedPlanId: string | null;
    selectedApplyId: string | null;
    selectedStateId: string | null;
    selectedLegacyIndex: number;
    selectedResourceAddress: string | null;
    resourceSearchText: string;
    /** The action group the selected plan's resource list is narrowed to, if any. */
    resourceActionFilter: ActionGroup | null;
    selectedStateAddress: string | null;
    stateSearchText: string;
    /** The digest item whose "View raw digest" expander is open, if any; only that one renders its raw body. */
    openRawDetails: { pivot: Pivot; id: string } | null;
    /** During the first load, how many attachments have downloaded out of how many. */
    loadingProgress: { done: number; total: number } | null;
    /** Whether the plan's unchanged (no-op) resources are listed; hidden by default. */
    showUnchangedResources: boolean;
    /** Whether the plan's unchanged (no-op) output changes are listed; hidden by default. */
    showUnchangedOutputs: boolean;
    /** Sections the reviewer has opened or closed; anything absent uses DEFAULT_SECTION_OPEN. */
    sectionOpen: Partial<Record<SectionKey, boolean>>;
}

function byNameCaseInsensitive<T extends { name: string }>(a: T, b: T): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

type OkDigestItem = Extract<DigestItem, { status: "ok" }>;

function okItemsOf(items: DigestItem[]): OkDigestItem[] {
    return items.filter((i): i is OkDigestItem => i.status === "ok");
}

/** Plan output changes that actually change something (the Output changes heading count). */
function countChangedOutputs(outputs: OutputChange[]): number {
    return outputs.reduce((n, output) => (output.action === "no-op" ? n : n + 1), 0);
}

/** "2 errors, 1 warning" for the Diagnostics heading; "0" when there are none. */
function formatDiagnosticCounts(diagnostics: Diagnostic[]): string {
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.length - errors;
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
    if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
    return parts.length > 0 ? parts.join(", ") : "0";
}

export class TerraformPlanTab extends React.Component<{}, TerraformTabState> {
    /**
     * onBuildChanged fires again as the build progresses, possibly while an
     * earlier loadAll is still downloading. Each load takes the next number;
     * only the newest may commit, so an older load that finishes late can
     * never overwrite newer results or errors.
     */
    private loadSequence = 0;

    // Roll-ups and overview rows for the multi-item header, recomputed only when
    // the item array itself changes (i.e. on load), not on every render.
    private readonly planRollup = memoizeOne((items: DigestItem[]) => aggregatePlanRollup(okItemsOf(items)));
    private readonly applyRollup = memoizeOne((items: DigestItem[]) => aggregateApplyRollup(okItemsOf(items)));
    private readonly stateRollup = memoizeOne((items: DigestItem[]) => aggregateStateRollup(okItemsOf(items)));
    private readonly planOverview = memoizeOne((items: DigestItem[]) => items.map(toPlanOverviewItem));
    private readonly applyOverview = memoizeOne((items: DigestItem[]) => items.map(toApplyOverviewItem));
    private readonly stateOverview = memoizeOne((items: DigestItem[]) => items.map(toStateOverviewItem));
    private readonly attention = memoizeOne(collectAttention);
    /** Legacy CLI outputs whose name matches no structured plan, with their position in `legacyRaw`. */
    private readonly unclaimedCliOutputs = memoizeOne((planItems: DigestItem[], legacyRaw: RawAttachment[]) =>
        legacyRaw
            .map((raw, index) => ({ raw, index }))
            .filter(({ raw }) => !planItems.some((plan) => plan.name === raw.name))
    );
    private readonly sectionToggles = new Map<SectionKey, () => void>();

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
            loadedBuildId: null,
            selectedPlanId: null,
            selectedApplyId: null,
            selectedStateId: null,
            selectedLegacyIndex: 0,
            selectedResourceAddress: null,
            resourceSearchText: "",
            resourceActionFilter: null,
            selectedStateAddress: null,
            stateSearchText: "",
            openRawDetails: null,
            loadingProgress: null,
            showUnchangedResources: false,
            showUnchangedOutputs: false,
            sectionOpen: {},
        };
    }

    public render(): JSX.Element {
        const { loading, error } = this.state;

        if (loading) {
            const progress = this.state.loadingProgress;
            return (
                <div className="plan-loading">
                    Loading terraform results...
                    {progress && progress.total > 0 && ` (${progress.done} of ${progress.total})`}
                </div>
            );
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
                    Set <code>publishPlanResults</code>, <code>publishPlanSummary</code>,{" "}
                    <code>publishApplyResults</code>, or <code>publishStateResults</code> on the terraform task to
                    publish results here.
                </div>
            );
        }

        const anyApplyFailed = applyItems.some(isFailedApply);
        const pivotTab = (pivot: Pivot, label: string, count: number, failed = false): JSX.Element => (
            <button
                role="tab"
                aria-selected={this.state.activePivot === pivot}
                className={`pivot-tab${this.state.activePivot === pivot ? " active" : ""}`}
                onClick={() => this.setActivePivot(pivot)}
            >
                {label} <span className="pivot-count">{count}</span>
                {failed && <span className="pivot-status-failed"> failed</span>}
            </button>
        );

        return (
            <div className="terraform-container">
                <MemoAttentionStrip
                    items={this.attention(planItems, applyItems, stateItems)}
                    onSelect={this.onSelectAttention}
                />
                <div className="pivot-bar" role="tablist">
                    {pivotTab("plan", "Plan", planItems.length > 0 ? planItems.length : legacyRaw.length)}
                    {pivotTab("apply", "Apply", applyItems.length, anyApplyFailed)}
                    {pivotTab("state", "State", stateItems.length)}
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

        const rollup = this.planRollup(planItems);
        const overviewItems: OverviewItem[] = this.planOverview(planItems);
        const selected = planItems.find((i) => i.id === selectedPlanId) ?? planItems[0];

        return (
            <div className="pivot-panel">
                {planItems.length > 1 && (
                    <MemoSummaryHeader
                        title={`All plans (${planItems.length})`}
                        kind="plan"
                        counts={rollup.counts}
                        noChanges={rollup.noChanges}
                        driftDetected={rollup.driftDetected}
                    />
                )}
                {planItems.length > 1 && (
                    <MemoOverviewList items={overviewItems} selectedId={selectedPlanId} onSelect={this.onSelectPlan} />
                )}
                {selected && this.renderPlanDetail(selected)}
                {this.renderUnclaimedCliOutputs()}
            </div>
        );
    }

    /**
     * Legacy CLI output (`publishPlanResults`) whose name matches no structured
     * plan, one collapsed section each. Without these it would only be
     * reachable when no structured plan was published at all.
     */
    private renderUnclaimedCliOutputs(): JSX.Element | null {
        const unclaimed = this.unclaimedCliOutputs(this.state.planItems, this.state.legacyRaw);
        if (unclaimed.length === 0) return null;
        return (
            <React.Fragment>
                {unclaimed.map(({ raw, index }) => {
                    const key: SectionKey = `cli:${index}:${raw.name}`;
                    return (
                        <Section
                            key={key}
                            title="Terraform CLI output"
                            count={raw.name}
                            className="cli-section"
                            open={this.isSectionOpen(key)}
                            onToggle={this.sectionToggle(key)}
                        >
                            {() => <RawView name={raw.name} content={raw.content} format="ansi" />}
                        </Section>
                    );
                })}
            </React.Fragment>
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
        const drift = digest.drift;
        const { selectedResourceAddress, resourceSearchText, resourceActionFilter, showUnchangedResources, showUnchangedOutputs } =
            this.state;
        // The same step usually publishes both under one name.
        const cliOutput = this.state.legacyRaw.find((raw) => raw.name === item.name);

        return (
            <div className="digest-detail">
                {item.unknownVersion && <div className="unknown-version-banner">{item.notes.join(" ")}</div>}
                <MemoSummaryHeader
                    title={item.name}
                    kind="plan"
                    counts={digest.summary}
                    noChanges={digest.summary.noChanges}
                    driftDetected={digest.summary.driftDetected}
                    destroyMode={digest.planMode === "destroy"}
                    truncated={digest.truncated}
                    truncationNotes={digest.truncationNotes}
                    toolLabel={`${digest.tool.name} ${digest.tool.version}`}
                    originLabel={originLabel(item)}
                    workingDirectory={digest.meta.workingDirectory}
                    logUrl={item.origin?.logUrl}
                    notFromTerraformTask={item.origin ? !item.origin.fromTerraformTask : undefined}
                />
                <Section
                    title="Resource changes"
                    count={countChangedResources(digest.resources)}
                    open={this.isSectionOpen("plan.changes")}
                    onToggle={this.sectionToggle("plan.changes")}
                >
                    {() => (
                        <MemoResourceList
                            resources={digest.resources}
                            selectedAddress={selectedResourceAddress}
                            onSelect={this.onSelectResource}
                            searchText={resourceSearchText}
                            onSearchTextChange={this.onResourceSearchChange}
                            showUnchanged={showUnchangedResources}
                            onToggleUnchanged={this.onToggleUnchangedResources}
                            actionFilter={resourceActionFilter}
                            onActionFilterChange={this.onResourceActionFilterChange}
                        />
                    )}
                </Section>
                {drift && drift.length > 0 && (
                    <Section
                        title="Drift"
                        count={drift.length}
                        className="drift-section"
                        open={this.isSectionOpen("plan.drift")}
                        onToggle={this.sectionToggle("plan.drift")}
                    >
                        {() => <MemoDriftList drift={drift} />}
                    </Section>
                )}
                <Section
                    title="Output changes"
                    count={countChangedOutputs(digest.outputChanges)}
                    open={this.isSectionOpen("plan.outputs")}
                    onToggle={this.sectionToggle("plan.outputs")}
                >
                    {() => (
                        <MemoOutputsPanel
                            outputs={digest.outputChanges}
                            showUnchanged={showUnchangedOutputs}
                            onToggleUnchanged={this.onToggleUnchangedOutputs}
                        />
                    )}
                </Section>
                {cliOutput && (
                    <Section
                        title="Terraform CLI output"
                        className="cli-section"
                        open={this.isSectionOpen("plan.cli")}
                        onToggle={this.sectionToggle("plan.cli")}
                    >
                        {() => <RawView name={cliOutput.name} content={cliOutput.content} format="ansi" />}
                    </Section>
                )}
                {this.renderRawDetails("plan", item)}
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

        const rollup = this.applyRollup(applyItems);
        const overviewItems: OverviewItem[] = this.applyOverview(applyItems);
        const selected = applyItems.find((i) => i.id === selectedApplyId) ?? applyItems[0];

        return (
            <div className="pivot-panel">
                {applyItems.length > 1 && (
                    <MemoSummaryHeader title={`All applies (${applyItems.length})`} kind="apply" counts={rollup.counts} />
                )}
                {applyItems.length > 1 && (
                    <MemoOverviewList items={overviewItems} selectedId={selectedApplyId} onSelect={this.onSelectApply} />
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
        const failed = digest.outcome === "failed";
        // The task leaves diagnostics out unless includeDiagnostics is set, and the
        // digest doesn't record which happened, so an empty list on a failed apply
        // is explained rather than shown as "No diagnostics".
        const diagnosticsMissing = failed && digest.diagnostics.length === 0;

        const resourcesSection = (
            <Section
                key="resources"
                title="Resources"
                count={digest.resources.length}
                open={this.isSectionOpen("apply.resources")}
                onToggle={this.sectionToggle("apply.resources")}
            >
                {() => (
                    <MemoApplyTimeline
                        resources={digest.resources}
                        appliedBeforeFailure={digest.appliedBeforeFailure}
                        outcome={digest.outcome}
                    />
                )}
            </Section>
        );
        const diagnosticsSection = (
            <Section
                key="diagnostics"
                title="Diagnostics"
                count={diagnosticsMissing ? "none included" : formatDiagnosticCounts(digest.diagnostics)}
                open={this.isSectionOpen("apply.diagnostics")}
                onToggle={this.sectionToggle("apply.diagnostics")}
            >
                {() =>
                    diagnosticsMissing ? (
                        <p className="diagnostics-missing">
                            No diagnostics were included in this summary. The task leaves them out unless the apply
                            step sets <code>includeDiagnostics</code>; the step's log has the full error output.
                        </p>
                    ) : (
                        <MemoDiagnosticsPanel diagnostics={digest.diagnostics} />
                    )
                }
            </Section>
        );

        return (
            <div className="digest-detail">
                {item.unknownVersion && <div className="unknown-version-banner">{item.notes.join(" ")}</div>}
                <MemoSummaryHeader
                    title={item.name}
                    kind="apply"
                    counts={digest.summary}
                    outcome={digest.outcome}
                    truncated={digest.truncated}
                    truncationNotes={digest.truncationNotes}
                    toolLabel={`${digest.tool.name} ${digest.tool.version}`}
                    originLabel={originLabel(item)}
                    workingDirectory={digest.meta.workingDirectory}
                    logUrl={item.origin?.logUrl}
                    notFromTerraformTask={item.origin ? !item.origin.fromTerraformTask : undefined}
                    durationMs={digest.summary.durationMs}
                />
                {/* A failed apply leads with why it failed. */}
                {failed ? [diagnosticsSection, resourcesSection] : [resourcesSection, diagnosticsSection]}
                <Section
                    title="Outputs"
                    count={digest.outputs.length}
                    open={this.isSectionOpen("apply.outputs")}
                    onToggle={this.sectionToggle("apply.outputs")}
                >
                    {() => <MemoOutputsPanel outputs={digest.outputs} />}
                </Section>
                {this.renderRawDetails("apply", item)}
            </div>
        );
    }

    private renderStatePivot(): JSX.Element {
        const { stateItems, selectedStateId } = this.state;

        if (stateItems.length === 0) {
            return <div className="plan-empty">No terraform state has been published for this pipeline run.</div>;
        }

        const rollup = this.stateRollup(stateItems);
        const overviewItems: OverviewItem[] = this.stateOverview(stateItems);
        const selected = stateItems.find((i) => i.id === selectedStateId) ?? stateItems[0];

        return (
            <div className="pivot-panel">
                {stateItems.length > 1 && (
                    <MemoSummaryHeader title={`All state (${stateItems.length})`} kind="state" stateCounts={rollup} />
                )}
                {stateItems.length > 1 && (
                    <MemoOverviewList items={overviewItems} selectedId={selectedStateId} onSelect={this.onSelectState} />
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
                <MemoSummaryHeader
                    title={item.name}
                    kind="state"
                    stateCounts={digest.summary}
                    truncated={digest.truncated}
                    truncationNotes={digest.truncationNotes}
                    toolLabel={`${digest.tool.name} ${digest.tool.version}`}
                    originLabel={originLabel(item)}
                    workingDirectory={digest.meta.workingDirectory}
                    logUrl={item.origin?.logUrl}
                    notFromTerraformTask={item.origin ? !item.origin.fromTerraformTask : undefined}
                />
                <Section
                    title="Resources"
                    count={digest.resources.length}
                    open={this.isSectionOpen("state.resources")}
                    onToggle={this.sectionToggle("state.resources")}
                >
                    {() => (
                        <MemoStateInventory
                            resources={digest.resources}
                            selectedAddress={selectedStateAddress}
                            onSelect={this.onSelectStateResource}
                            searchText={stateSearchText}
                            onSearchTextChange={this.onStateSearchTextChange}
                        />
                    )}
                </Section>
                <Section
                    title="Outputs"
                    count={digest.outputs.length}
                    open={this.isSectionOpen("state.outputs")}
                    onToggle={this.sectionToggle("state.outputs")}
                >
                    {() => <MemoOutputsPanel outputs={digest.outputs} />}
                </Section>
                {this.renderRawDetails("state", item)}
            </div>
        );
    }

    private renderDigestError(item: { message: string; raw: RawAttachment; name: string }): JSX.Element {
        return (
            <div className="digest-parse-error">
                <p>
                    Could not render structured results for <strong>{item.name}</strong>: {item.message}
                </p>
                <RawView name={item.raw.name} content={item.raw.content} format="text" />
            </div>
        );
    }

    /**
     * The collapsed "View raw digest" expander under each structured detail
     * view. Its body is only rendered while it is open: the tab re-renders on
     * every state change (each search keystroke), and re-rendering up to 2 MB
     * of raw digest behind a closed expander each time is pure overhead.
     */
    private renderRawDetails(pivot: Pivot, item: DigestItem): JSX.Element {
        const { openRawDetails } = this.state;
        const open = openRawDetails !== null && openRawDetails.pivot === pivot && openRawDetails.id === item.id;
        return (
            <details
                className="raw-details"
                open={open}
                onToggle={(event) => this.onRawDetailsToggle(pivot, item.id, event.currentTarget.open)}
            >
                <summary>View raw digest</summary>
                {open && <RawView name={item.raw.name} content={item.raw.content} format="text" />}
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
                {selected && <RawView name={selected.name} content={selected.content} format="ansi" />}
            </div>
        );
    }

    private setActivePivot = (pivot: Pivot): void => {
        this.setState({ activePivot: pivot });
    };

    /**
     * Mirrors a raw-digest expander's DOM `toggle` event into state. A close
     * reported by any expander other than the open one is ignored: that is
     * React closing a reused <details> element after the selection moved on.
     */
    private onRawDetailsToggle = (pivot: Pivot, id: string, open: boolean): void => {
        this.setState((prev: TerraformTabState) => {
            const isOpen = prev.openRawDetails !== null && prev.openRawDetails.pivot === pivot && prev.openRawDetails.id === id;
            if (open === isOpen) return null;
            return { openRawDetails: open ? { pivot, id } : null };
        });
    };

    private onSelectPlan = (id: string): void => {
        this.setState({ selectedPlanId: id, selectedResourceAddress: null, resourceSearchText: "", resourceActionFilter: null });
    };

    /** Opens an item from the "Needs review" strip: its pivot, then the item itself. */
    private onSelectAttention = (pivot: Pivot, id: string): void => {
        this.setActivePivot(pivot);
        if (pivot === "plan") {
            if (this.state.selectedPlanId !== id) this.onSelectPlan(id);
        } else if (pivot === "apply") {
            this.onSelectApply(id);
        } else if (this.state.selectedStateId !== id) {
            this.onSelectState(id);
        }
    };

    private onResourceActionFilterChange = (group: ActionGroup | null): void => {
        this.setState({ resourceActionFilter: group });
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

    private onToggleUnchangedResources = (): void => {
        this.setState((prev: TerraformTabState) => ({ showUnchangedResources: !prev.showUnchangedResources }));
    };

    private onToggleUnchangedOutputs = (): void => {
        this.setState((prev: TerraformTabState) => ({ showUnchangedOutputs: !prev.showUnchangedOutputs }));
    };

    private isSectionOpen(key: SectionKey): boolean {
        return this.state.sectionOpen[key] ?? defaultSectionOpen(key);
    }

    private onToggleSection = (key: SectionKey): void => {
        this.setState((prev: TerraformTabState) => ({
            sectionOpen: { ...prev.sectionOpen, [key]: !(prev.sectionOpen[key] ?? defaultSectionOpen(key)) },
        }));
    };

    /** One stable toggle callback per section, so a Section's props don't change identity on every render. */
    private sectionToggle(key: SectionKey): () => void {
        let toggle = this.sectionToggles.get(key);
        if (!toggle) {
            toggle = () => this.onToggleSection(key);
            this.sectionToggles.set(key, toggle);
        }
        return toggle;
    }

    private onSelectLegacy = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        this.setState({ selectedLegacyIndex: parseInt(event.target.value, 10) });
    };

    /** Whether a later loadAll has started since the one that took `sequence`. */
    private isSuperseded(sequence: number): boolean {
        return sequence !== this.loadSequence;
    }

    /** Counts one finished download toward the first load's progress line; reloads show their results instead. */
    private markDownloaded = (sequence: number): void => {
        if (this.isSuperseded(sequence)) return;
        this.setState((prev: TerraformTabState) =>
            prev.loading && prev.loadingProgress
                ? { loadingProgress: { ...prev.loadingProgress, done: prev.loadingProgress.done + 1 } }
                : null
        );
    };

    /**
     * Fetch each attachment's body, a few at a time, parse it as a plan/apply/state digest, and classify it as ok/error, in
     * attachment order. Non-OK HTTP responses and network failures are skipped (logged), matching the legacy loader's
     * behavior. Stops starting downloads once a newer load supersedes `sequence`, since its results will replace these.
     */
    private async loadDigestItems(
        attachments: AttachmentRef[],
        authHeader: string,
        expectedKind: "plan" | "apply" | "state",
        sequence: number,
        originOf: OriginLookup | undefined
    ): Promise<DigestItem[]> {
        // The id keys the selection across reloads, so it counts only earlier
        // attachments of the same name rather than the position in the list: an
        // attachment published later in the build must not renumber the rest.
        const occurrences = new Map<string, number>();
        const ids = attachments.map((attachment) => {
            const occurrence = occurrences.get(attachment.name) ?? 0;
            occurrences.set(attachment.name, occurrence + 1);
            return `${attachment.name}#${occurrence}`;
        });

        const loaded = await mapWithConcurrency(attachments, DOWNLOAD_CONCURRENCY, async (attachment, index) => {
            if (this.isSuperseded(sequence)) return null;
            const id = ids[index];
            const origin = originOf?.(attachment._links.self.href);
            try {
                const response = await fetch(attachment._links.self.href, { headers: { Authorization: authHeader } });
                if (!response.ok) return null;
                const contentLengthHeader = response.headers.get("content-length");
                const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
                const byteLength = Number.isFinite(parsedLength) ? parsedLength : undefined;

                // Guard the body size BEFORE buffering it: a declared Content-Length
                // over the parse ceiling means we refuse to read the (potentially
                // multi-MB) body into memory at all — reading it first would be the
                // very OOM the ceiling exists to prevent. Without a declared length the
                // body is streamed, and the read stops as soon as it passes the ceiling.
                if (byteLength !== undefined && byteLength > TAB_PARSE_CEILING_BYTES) {
                    return errorItem(
                        id,
                        attachment.name,
                        origin,
                        `Digest is ${byteLength} bytes, over the ${TAB_PARSE_CEILING_BYTES}-byte tab parse ceiling; not loaded.`
                    );
                }
                const body = await readBodyCapped(response, TAB_PARSE_CEILING_BYTES);
                if (!body.ok) {
                    return errorItem(
                        id,
                        attachment.name,
                        origin,
                        `Digest is over the ${TAB_PARSE_CEILING_BYTES}-byte tab parse ceiling (stopped reading after ${body.bytesRead} bytes); not loaded.`
                    );
                }

                const parsed = parseDigestText(body.text, body.bytes);
                if (parsed.ok && parsed.digest.kind === expectedKind) {
                    const item: DigestItem = {
                        id,
                        name: attachment.name,
                        status: "ok",
                        digest: parsed.digest,
                        unknownVersion: parsed.unknownVersion,
                        notes: parsed.notes,
                        raw: { name: attachment.name, content: body.text },
                        origin,
                    };
                    return item;
                }
                const message = parsed.ok
                    ? `Digest kind "${parsed.digest.kind}" does not match the expected "${expectedKind}" attachment type.`
                    : parsed.message;
                return errorItem(id, attachment.name, origin, message, body.text);
            } catch (err) {
                console.error(`Failed to download attachment ${attachment.name}:`, err);
                return null;
            } finally {
                this.markDownloaded(sequence);
            }
        });
        return loaded.filter((item): item is DigestItem => item !== null);
    }

    /** Legacy CLI output attachments, a few at a time and under the same byte ceiling as digests, in attachment order. */
    private async loadRawAttachments(attachments: AttachmentRef[], authHeader: string, sequence: number): Promise<RawAttachment[]> {
        const loaded = await mapWithConcurrency(attachments, DOWNLOAD_CONCURRENCY, async (attachment) => {
            if (this.isSuperseded(sequence)) return null;
            try {
                const response = await fetch(attachment._links.self.href, { headers: { Authorization: authHeader } });
                if (!response.ok) return null;
                const declared = Number(response.headers.get("content-length") ?? NaN);
                if (Number.isFinite(declared) && declared > TAB_PARSE_CEILING_BYTES) {
                    return oversizeRawAttachment(attachment.name, declared);
                }
                const body = await readBodyCapped(response, TAB_PARSE_CEILING_BYTES);
                return body.ok ? { name: attachment.name, content: body.text } : oversizeRawAttachment(attachment.name, body.bytesRead);
            } catch (err) {
                console.error(`Failed to download attachment ${attachment.name}:`, err);
                return null;
            } finally {
                this.markDownloaded(sequence);
            }
        });
        return loaded.filter((item): item is RawAttachment => item !== null);
    }

    /**
     * The build's timeline records, which say which step published each attachment; undefined when they can't be read,
     * in which case items sort by name and show no step.
     */
    private async loadTimelineRecords(buildClient: BuildRestClient, build: Build): Promise<TimelineRecordLike[] | undefined> {
        if (typeof buildClient.getBuildTimeline !== "function") return undefined;
        try {
            const timeline = await buildClient.getBuildTimeline(build.project.id, build.id);
            return Array.isArray(timeline?.records) ? timeline.records : undefined;
        } catch (err) {
            console.error("Failed to read the build timeline:", err);
            return undefined;
        }
    }

    public async loadAll(build: Build): Promise<void> {
        const sequence = ++this.loadSequence;
        try {
            const buildClient = getClient(BuildRestClient);
            const accessToken = await SDK.getAccessToken();
            const authHeader = "Basic " + btoa(":" + accessToken);

            const [planAttachments, applyAttachments, stateAttachments, legacyAttachments, timelineRecords] = await Promise.all([
                buildClient.getAttachments(build.project.id, build.id, PLAN_SUMMARY_ATTACHMENT_TYPE),
                buildClient.getAttachments(build.project.id, build.id, APPLY_SUMMARY_ATTACHMENT_TYPE),
                buildClient.getAttachments(build.project.id, build.id, STATE_SUMMARY_ATTACHMENT_TYPE),
                buildClient.getAttachments(build.project.id, build.id, LEGACY_RAW_ATTACHMENT_TYPE),
                this.loadTimelineRecords(buildClient, build),
            ]);
            if (this.isSuperseded(sequence)) return;

            const originOf = timelineRecords ? buildOriginLookup(timelineRecords, build.id) : undefined;
            const plans = planAttachments ?? [];
            const applies = applyAttachments ?? [];
            const states = stateAttachments ?? [];
            const legacy = legacyAttachments ?? [];
            if (this.state.loading) {
                this.setState({ loadingProgress: { done: 0, total: plans.length + applies.length + states.length + legacy.length } });
            }

            const [planItems, applyItems, stateItems, legacyRaw] = await Promise.all([
                this.loadDigestItems(plans, authHeader, "plan", sequence, originOf),
                this.loadDigestItems(applies, authHeader, "apply", sequence, originOf),
                this.loadDigestItems(states, authHeader, "state", sequence, originOf),
                this.loadRawAttachments(legacy, authHeader, sequence),
            ]);
            if (this.isSuperseded(sequence)) return;

            planItems.sort(byRunOrder);
            applyItems.sort(byRunOrder);
            stateItems.sort(byRunOrder);
            legacyRaw.sort(byNameCaseInsensitive);

            const loaded: LoadedResults = { planItems, applyItems, stateItems, legacyRaw };
            this.setState((prev: TerraformTabState) => ({
                ...loaded,
                ...reconcileSelections(prev, loaded, build.id),
                loadedBuildId: build.id,
                error: null,
                loading: false,
                loadingProgress: null,
            }));
        } catch (err) {
            if (this.isSuperseded(sequence)) return;
            const message = err instanceof Error ? err.message : String(err);
            this.setState({ error: message, loading: false, loadingProgress: null });
        }
    }
}

/** A digest item that couldn't be shown structurally, with whatever body was read. */
function errorItem(id: string, name: string, origin: AttachmentOrigin | undefined, message: string, content = ""): DigestItem {
    return { id, name, status: "error", message, raw: { name, content }, origin };
}

/** Stands in for a legacy CLI output too large to load: the raw view shows this notice instead of the output. */
function oversizeRawAttachment(name: string, bytes: number): RawAttachment {
    return {
        name,
        content: `Output not loaded: it is over the tab's ${TAB_PARSE_CEILING_BYTES}-byte limit (at least ${bytes} bytes).`,
    };
}

/** Pipeline order (stage, job, step) when the timeline placed both items, then name. */
function byRunOrder(a: DigestItem, b: DigestItem): number {
    return compareOrigins(a.origin, b.origin) || byNameCaseInsensitive(a, b);
}

/**
 * "Stage › Job › Step" from the build timeline, or, without it, the stage and
 * job the digest itself recorded. Undefined when neither says anything.
 */
function originLabel(item: DigestItem): string | undefined {
    if (item.origin) return formatOrigin(item.origin) || undefined;
    if (item.status !== "ok") return undefined;
    return [item.digest.meta.stage, item.digest.meta.job].filter((part): part is string => !!part).join(" › ") || undefined;
}

function overviewOrigin(item: DigestItem): OverviewOrigin | undefined {
    const label = originLabel(item);
    if (label === undefined && !item.origin) return undefined;
    return { label, fromTerraformTask: item.origin?.fromTerraformTask };
}

interface LoadedResults {
    planItems: DigestItem[];
    applyItems: DigestItem[];
    stateItems: DigestItem[];
    legacyRaw: RawAttachment[];
}

type Selections = Pick<
    TerraformTabState,
    | "activePivot"
    | "selectedPlanId"
    | "selectedApplyId"
    | "selectedStateId"
    | "selectedLegacyIndex"
    | "selectedResourceAddress"
    | "resourceSearchText"
    | "resourceActionFilter"
    | "selectedStateAddress"
    | "stateSearchText"
    | "openRawDetails"
>;

/**
 * The user's selections after a load. A reload of the same build keeps each
 * selection whose target still exists in the new data, and only what no
 * longer resolves falls back to its default; a first load (nothing shown
 * yet) or a different build starts from the defaults.
 */
function reconcileSelections(prev: TerraformTabState, loaded: LoadedResults, buildId: number): Selections {
    const carryOver = prev.loadedBuildId === buildId && hasResults(prev);
    const selectedPlanId = keepSelectedId(carryOver ? prev.selectedPlanId : null, loaded.planItems, planRisk);
    const selectedStateId = keepSelectedId(carryOver ? prev.selectedStateId : null, loaded.stateItems);
    // A resource selection and its search text belong to the plan (or state
    // item) they were made in: onSelectPlan/onSelectState clear both, so they
    // survive only alongside that item.
    const planKept = carryOver && selectedPlanId !== null && selectedPlanId === prev.selectedPlanId;
    const stateKept = carryOver && selectedStateId !== null && selectedStateId === prev.selectedStateId;
    const openRawDetails = carryOver ? prev.openRawDetails : null;
    return {
        activePivot: carryOver ? prev.activePivot : defaultPivot(loaded),
        selectedPlanId,
        selectedApplyId: keepSelectedId(carryOver ? prev.selectedApplyId : null, loaded.applyItems, applyRisk),
        selectedStateId,
        selectedLegacyIndex: carryOver ? keepLegacyIndex(prev, loaded.legacyRaw) : 0,
        selectedResourceAddress:
            planKept && hasResource(loaded.planItems, selectedPlanId, prev.selectedResourceAddress)
                ? prev.selectedResourceAddress
                : null,
        resourceSearchText: planKept ? prev.resourceSearchText : "",
        resourceActionFilter: planKept ? prev.resourceActionFilter : null,
        selectedStateAddress:
            stateKept && hasResource(loaded.stateItems, selectedStateId, prev.selectedStateAddress)
                ? prev.selectedStateAddress
                : null,
        stateSearchText: stateKept ? prev.stateSearchText : "",
        openRawDetails:
            openRawDetails !== null && itemsForPivot(loaded, openRawDetails.pivot).some((i) => i.id === openRawDetails.id)
                ? openRawDetails
                : null,
    };
}

function hasResults(results: LoadedResults): boolean {
    return (
        results.planItems.length > 0 ||
        results.applyItems.length > 0 ||
        results.stateItems.length > 0 ||
        results.legacyRaw.length > 0
    );
}

/**
 * The pivot a first load opens on: Apply when an apply failed (why it failed
 * is the first question), else Plan when there is a plan (structured or legacy
 * raw), else the first of Apply/State with results.
 */
function defaultPivot(loaded: LoadedResults): Pivot {
    if (loaded.applyItems.some(isFailedApply)) return "apply";
    if (loaded.planItems.length > 0 || loaded.legacyRaw.length > 0) return "plan";
    if (loaded.applyItems.length > 0) return "apply";
    return loaded.stateItems.length > 0 ? "state" : "plan";
}

/**
 * `id` if it still names one of `items`, else the first-load default: the item
 * that most needs review by `risk` (ties keep list order), or the first item
 * when there is no risk ordering.
 */
function keepSelectedId(id: string | null, items: DigestItem[], risk?: (item: DigestItem) => number): string | null {
    if (id !== null && items.some((i) => i.id === id)) return id;
    return risk ? riskiestId(items, risk) : items[0]?.id ?? null;
}

/** Legacy raw attachments are selected by position; follow the selected one by name when the list changes. */
function keepLegacyIndex(prev: TerraformTabState, legacyRaw: RawAttachment[]): number {
    const name = prev.legacyRaw[prev.selectedLegacyIndex]?.name;
    if (name === undefined) return 0;
    if (legacyRaw[prev.selectedLegacyIndex]?.name === name) return prev.selectedLegacyIndex;
    return Math.max(0, legacyRaw.findIndex((raw) => raw.name === name));
}

/** Whether the item `id` in `items` is a parsed digest that has a resource at `address`. */
function hasResource(items: DigestItem[], id: string | null, address: string | null): boolean {
    if (address === null) return false;
    const item = items.find((i) => i.id === id);
    return item !== undefined && item.status === "ok" && item.digest.resources.some((r) => r.address === address);
}

function itemsForPivot(loaded: LoadedResults, pivot: Pivot): DigestItem[] {
    return pivot === "plan" ? loaded.planItems : pivot === "apply" ? loaded.applyItems : loaded.stateItems;
}

function toPlanOverviewItem(item: DigestItem): OverviewItem {
    if (item.status === "error" || item.digest.kind !== "plan") {
        return {
            id: item.id,
            name: item.name,
            status: "error",
            message: item.status === "error" ? item.message : "Unexpected digest kind.",
            origin: overviewOrigin(item),
        };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        origin: overviewOrigin(item),
        counts: { add: s.add, change: s.change, destroy: s.destroy, replace: s.replace, read: s.read, import: s.import },
        noChanges: s.noChanges,
        driftDetected: s.driftDetected,
        destroyMode: item.digest.planMode === "destroy",
    };
}

function toApplyOverviewItem(item: DigestItem): OverviewItem {
    if (item.status === "error" || item.digest.kind !== "apply") {
        return {
            id: item.id,
            name: item.name,
            status: "error",
            message: item.status === "error" ? item.message : "Unexpected digest kind.",
            origin: overviewOrigin(item),
        };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        origin: overviewOrigin(item),
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
    const rollup: PlanRollup = { counts: { add: 0, change: 0, destroy: 0, replace: 0, read: 0, import: 0 }, noChanges: items.length > 0, driftDetected: false };
    for (const item of items) {
        if (item.digest.kind !== "plan") continue;
        const s = item.digest.summary;
        rollup.counts.add += s.add;
        rollup.counts.change += s.change;
        rollup.counts.destroy += s.destroy;
        rollup.counts.replace = (rollup.counts.replace ?? 0) + s.replace;
        rollup.counts.read = (rollup.counts.read ?? 0) + s.read;
        rollup.counts.import = (rollup.counts.import ?? 0) + (s.import ?? 0);
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
        return {
            id: item.id,
            name: item.name,
            status: "error",
            message: item.status === "error" ? item.message : "Unexpected digest kind.",
            origin: overviewOrigin(item),
        };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        origin: overviewOrigin(item),
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
