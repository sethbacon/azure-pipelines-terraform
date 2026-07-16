import * as React from "react";
import { SummaryHeaderCounts } from "./SummaryHeader";

export type OverviewItem =
    | {
          id: string;
          name: string;
          status: "ok";
          counts: SummaryHeaderCounts;
          noChanges?: boolean;
          driftDetected?: boolean;
          outcome?: "succeeded" | "failed";
      }
    | {
          id: string;
          name: string;
          status: "error";
          message: string;
      };

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
                    <span className="overview-item-name">{item.name}</span>
                    {item.status === "error" ? (
                        <span className="overview-item-error">
                            <span className="badge badge-error">Unparseable</span>
                            <span className="overview-item-error-message">{item.message}</span>
                        </span>
                    ) : (
                        <span className="overview-item-badges">
                            <span className="count count-add">+{item.counts.add}</span>
                            <span className="count count-change">~{item.counts.change}</span>
                            <span className="count count-destroy">-{item.counts.destroy}</span>
                            {!!item.counts.replace && <span className="badge badge-replace">Replace</span>}
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
