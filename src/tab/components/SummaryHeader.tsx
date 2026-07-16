import * as React from "react";

export interface SummaryHeaderCounts {
    add: number;
    change: number;
    destroy: number;
    replace?: number;
    read?: number;
}

export interface SummaryHeaderProps {
    /** Untrusted digest name / roll-up label — rendered as a text node only. */
    title: string;
    kind: "plan" | "apply";
    counts: SummaryHeaderCounts;
    noChanges?: boolean;
    driftDetected?: boolean;
    /** Apply only. */
    outcome?: "succeeded" | "failed";
    truncated?: boolean;
    truncationNotes?: string[];
    toolLabel?: string;
}

/**
 * Summary counts + status badges for a single plan/apply digest, or an
 * aggregated roll-up across multiple digests. Every value is rendered as a
 * React text node — no HTML sinks.
 */
export function SummaryHeader(props: SummaryHeaderProps): JSX.Element {
    const { title, kind, counts, noChanges, driftDetected, outcome, truncated, truncationNotes, toolLabel } = props;

    return (
        <div className="summary-header">
            <div className="summary-header-title-row">
                <span className="summary-header-title">{title}</span>
                {toolLabel && <span className="summary-header-tool">{toolLabel}</span>}
                {kind === "apply" && outcome && (
                    <span className={`badge badge-outcome-${outcome}`}>
                        {outcome === "succeeded" ? "Succeeded" : "Failed"}
                    </span>
                )}
                {driftDetected && <span className="badge badge-drift">Drift detected</span>}
                {noChanges && <span className="badge badge-no-changes">No changes</span>}
            </div>
            <div className="summary-header-counts">
                <span className="count count-add">+{counts.add}</span>
                <span className="count count-change">~{counts.change}</span>
                <span className="count count-destroy">-{counts.destroy}</span>
                {typeof counts.replace === "number" && counts.replace > 0 && (
                    <span className="count count-replace">±{counts.replace} replace</span>
                )}
                {typeof counts.read === "number" && counts.read > 0 && (
                    <span className="count count-read">{counts.read} read</span>
                )}
            </div>
            {truncated && (
                <div className="summary-header-truncated">
                    <span>This digest was truncated.</span>
                    {truncationNotes && truncationNotes.length > 0 && (
                        <ul>
                            {truncationNotes.map((note, i) => (
                                <li key={i}>{note}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
