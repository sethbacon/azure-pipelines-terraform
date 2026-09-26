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
import { SummaryHeader, SummaryHeaderCounts, SummaryHeaderStateCounts } from "./components/SummaryHeader";
import { OverviewList, OverviewItem } from "./components/OverviewList";
import { ResourceList, countChangedResources } from "./components/ResourceList";
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
const MemoSummaryHeader = React.memo(SummaryHeader);
const MemoOverviewList = React.memo(OverviewList);
const MemoResourceList = React.memo(ResourceList);
const MemoDriftList = React.memo(DriftList);
const MemoApplyTimeline = React.memo(ApplyTimeline);
const MemoDiagnosticsPanel = React.memo(DiagnosticsPanel);
const MemoOutputsPanel = React.memo(OutputsPanel);
const MemoStateInventory = React.memo(StateInventory);

/** The collapsible sections of the three detail views. */
type SectionKey =
    | "plan.changes"
    | "plan.drift"
    | "plan.outputs"
    | "apply.resources"
    | "apply.diagnostics"
    | "apply.outputs"
    | "state.resources"
    | "state.outputs";

const DEFAULT_SECTION_OPEN: Record<SectionKey, boolean> = {
    "plan.changes": true,
    // Collapsed until asked for: drift can run to thousands of attribute tables,
    // and the summary header's badge and this section's count already flag it.
    "plan.drift": false,
    "plan.outputs": true,
    "apply.resources": true,
    "apply.diagnostics": true,
    "apply.outputs": true,
    "state.resources": true,
    "state.outputs": true,
};

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

type Pivot = "plan" | "apply" | "state";

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
    selectedStateAddress: string | null;
    stateSearchText: string;
    /** The digest item whose "View raw digest" expander is open, if any; only that one renders its raw body. */
    openRawDetails: { pivot: Pivot; id: string } | null;
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
            selectedStateAddress: null,
            stateSearchText: "",
            openRawDetails: null,
            showUnchangedResources: false,
            showUnchangedOutputs: false,
            sectionOpen: {},
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
                    Set <code>publishPlanResults</code>, <code>publishPlanSummary</code>,{" "}
                    <code>publishApplyResults</code>, or <code>publishStateResults</code> on the terraform task to
                    publish results here.
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
        const drift = digest.drift;
        const { selectedResourceAddress, resourceSearchText, showUnchangedResources, showUnchangedOutputs } = this.state;

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
                />
                <Section
                    title="Resources"
                    count={digest.resources.length}
                    open={this.isSectionOpen("apply.resources")}
                    onToggle={this.sectionToggle("apply.resources")}
                >
                    {() => (
                        <MemoApplyTimeline resources={digest.resources} appliedBeforeFailure={digest.appliedBeforeFailure} />
                    )}
                </Section>
                <Section
                    title="Diagnostics"
                    count={formatDiagnosticCounts(digest.diagnostics)}
                    open={this.isSectionOpen("apply.diagnostics")}
                    onToggle={this.sectionToggle("apply.diagnostics")}
                >
                    {() => <MemoDiagnosticsPanel diagnostics={digest.diagnostics} />}
                </Section>
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

    private onToggleUnchangedResources = (): void => {
        this.setState((prev: TerraformTabState) => ({ showUnchangedResources: !prev.showUnchangedResources }));
    };

    private onToggleUnchangedOutputs = (): void => {
        this.setState((prev: TerraformTabState) => ({ showUnchangedOutputs: !prev.showUnchangedOutputs }));
    };

    private isSectionOpen(key: SectionKey): boolean {
        return this.state.sectionOpen[key] ?? DEFAULT_SECTION_OPEN[key];
    }

    private onToggleSection = (key: SectionKey): void => {
        this.setState((prev: TerraformTabState) => ({
            sectionOpen: { ...prev.sectionOpen, [key]: !(prev.sectionOpen[key] ?? DEFAULT_SECTION_OPEN[key]) },
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

    /** Fetch an attachment's body, parse it as a plan/apply digest, and classify it as ok/error. Non-OK HTTP responses and network failures are skipped (logged), matching the legacy loader's behavior. Stops early once a newer load supersedes `sequence`, since its results will replace these. */
    private async loadDigestItems(
        attachments: AttachmentRef[],
        authHeader: string,
        expectedKind: "plan" | "apply" | "state",
        sequence: number
    ): Promise<DigestItem[]> {
        const items: DigestItem[] = [];
        // The id keys the selection across reloads, so it counts only earlier
        // attachments of the same name rather than the position in the list: an
        // attachment published later in the build must not renumber the rest.
        const occurrences = new Map<string, number>();
        for (const attachment of attachments) {
            if (this.isSuperseded(sequence)) break;
            const occurrence = occurrences.get(attachment.name) ?? 0;
            occurrences.set(attachment.name, occurrence + 1);
            const id = `${attachment.name}#${occurrence}`;
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

    private async loadRawAttachments(attachments: AttachmentRef[], authHeader: string, sequence: number): Promise<RawAttachment[]> {
        const items: RawAttachment[] = [];
        for (const attachment of attachments) {
            if (this.isSuperseded(sequence)) break;
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
        const sequence = ++this.loadSequence;
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
            if (this.isSuperseded(sequence)) return;

            const [planItems, applyItems, stateItems, legacyRaw] = await Promise.all([
                this.loadDigestItems(planAttachments ?? [], authHeader, "plan", sequence),
                this.loadDigestItems(applyAttachments ?? [], authHeader, "apply", sequence),
                this.loadDigestItems(stateAttachments ?? [], authHeader, "state", sequence),
                this.loadRawAttachments(legacyAttachments ?? [], authHeader, sequence),
            ]);
            if (this.isSuperseded(sequence)) return;

            planItems.sort(byNameCaseInsensitive);
            applyItems.sort(byNameCaseInsensitive);
            stateItems.sort(byNameCaseInsensitive);
            legacyRaw.sort(byNameCaseInsensitive);

            const loaded: LoadedResults = { planItems, applyItems, stateItems, legacyRaw };
            this.setState((prev: TerraformTabState) => ({
                ...loaded,
                ...reconcileSelections(prev, loaded, build.id),
                loadedBuildId: build.id,
                error: null,
                loading: false,
            }));
        } catch (err) {
            if (this.isSuperseded(sequence)) return;
            const message = err instanceof Error ? err.message : String(err);
            this.setState({ error: message, loading: false });
        }
    }
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
    const selectedPlanId = keepSelectedId(carryOver ? prev.selectedPlanId : null, loaded.planItems);
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
        selectedApplyId: keepSelectedId(carryOver ? prev.selectedApplyId : null, loaded.applyItems),
        selectedStateId,
        selectedLegacyIndex: carryOver ? keepLegacyIndex(prev, loaded.legacyRaw) : 0,
        selectedResourceAddress:
            planKept && hasResource(loaded.planItems, selectedPlanId, prev.selectedResourceAddress)
                ? prev.selectedResourceAddress
                : null,
        resourceSearchText: planKept ? prev.resourceSearchText : "",
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

/** The pivot a first load opens on: Plan when there is a plan (structured or legacy raw), else the first of Apply/State with results. */
function defaultPivot(loaded: LoadedResults): Pivot {
    if (loaded.planItems.length > 0 || loaded.legacyRaw.length > 0) return "plan";
    if (loaded.applyItems.length > 0) return "apply";
    return loaded.stateItems.length > 0 ? "state" : "plan";
}

/** `id` if it still names one of `items`, else the first item's id (the first-load default). */
function keepSelectedId(id: string | null, items: DigestItem[]): string | null {
    return id !== null && items.some((i) => i.id === id) ? id : items[0]?.id ?? null;
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
        return { id: item.id, name: item.name, status: "error", message: item.status === "error" ? item.message : "Unexpected digest kind." };
    }
    const s = item.digest.summary;
    return {
        id: item.id,
        name: item.name,
        status: "ok",
        counts: { add: s.add, change: s.change, destroy: s.destroy, replace: s.replace, read: s.read, import: s.import },
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
