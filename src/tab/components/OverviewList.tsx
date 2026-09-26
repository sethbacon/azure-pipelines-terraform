import * as React from "react";
import { SummaryHeaderCounts, SummaryHeaderStateCounts } from "./SummaryHeader";

/** Where an item came from, shown under its name (see origin.ts). */
export interface OverviewOrigin {
    /** "Stage › Job › Step" from the build timeline, or the digest's own stage/job. */
    label?: string;
    /** False when the timeline shows a step other than the Terraform task published it. */
    fromTerraformTask?: boolean;
}

export type OverviewItem = (
    | {
          id: string;
          name: string;
          status: "ok";
          /** Plan/apply items only; a state item carries `stateCounts` instead. */
          counts?: SummaryHeaderCounts;
          /** State items only (digest spec §7.2). */
          stateCounts?: SummaryHeaderStateCounts;
          noChanges?: boolean;
          driftDetected?: boolean;
          outcome?: "succeeded" | "failed";
          /** Plan items only: true when the digest's `planMode === "destroy"` (digest spec §7.1). */
          destroyMode?: boolean;
      }
    | {
          id: string;
          name: string;
          status: "error";
          message: string;
      }
) & { origin?: OverviewOrigin };

export interface OverviewListProps {
    items: OverviewItem[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}

/**
 * Multi-item overview: one row per published plan/apply digest with name,
 * count chips, and status badges (drift/replace/no-op/error). Selecting a
 * row opens its detail view. All item names/messages are untrusted digest
 * text rendered as React text nodes.
 */
export function OverviewList({ items, selectedId, onSelect }: OverviewListProps): JSX.Element {
    if (items.length === 0) {
        return <div className="overview-empty">No items to display.</div>;
    }

    return (
        <ul className="overview-list" role="listbox">
            {items.map((item) => (
                <li
                    key={item.id}
                    role="option"
                    aria-selected={item.id === selectedId}
                    className={`overview-item${item.id === selectedId ? " selected" : ""}`}
                    onClick={() => onSelect(item.id)}
                >
                    <span className="overview-item-label">
                        <span className="overview-item-name">{item.name}</span>
                        {item.origin?.label && <span className="overview-item-origin">{item.origin.label}</span>}
                        {item.origin?.fromTerraformTask === false && (
                            <span className="badge badge-untrusted">Not from the Terraform task</span>
                        )}
                    </span>
                    {item.status === "error" ? (
                        <span className="overview-item-error">
                            <span className="badge badge-error">Unparseable</span>
                            <span className="overview-item-error-message">{item.message}</span>
                        </span>
                    ) : (
                        <span className="overview-item-badges">
                            {item.destroyMode && <span className="badge badge-destroy">Destroy</span>}
                            {item.counts && (
                                <React.Fragment>
                                    {!!item.counts.import && <span className="count count-import">{item.counts.import} import</span>}
                                    <span className="count count-add">+{item.counts.add}</span>
                                    <span className="count count-change">~{item.counts.change}</span>
                                    <span className="count count-destroy">-{item.counts.destroy}</span>
                                    {!!item.counts.replace && <span className="badge badge-replace">Replace</span>}
                                </React.Fragment>
                            )}
                            {item.stateCounts && (
                                <React.Fragment>
                                    <span className="count count-resources">{item.stateCounts.resourceCount} resources</span>
                                    <span className="count count-data-sources">{item.stateCounts.dataSourceCount} data sources</span>
                                </React.Fragment>
                            )}
                            {item.driftDetected && <span className="badge badge-drift">Drift</span>}
                            {item.noChanges && <span className="badge badge-no-changes">No changes</span>}
                            {item.outcome && (
                                <span className={`badge badge-outcome-${item.outcome}`}>
                                    {item.outcome === "succeeded" ? "Succeeded" : "Failed"}
                                </span>
                            )}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}
