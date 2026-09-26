import * as React from "react";
import { ApplyResource } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";
import { formatDuration } from "../format-duration";

/** How many of the slowest resources the "Slowest" line names. */
const SLOWEST_SHOWN = 3;

export interface ApplyTimelineProps {
    resources: ApplyResource[];
    appliedBeforeFailure?: string[];
    maxRenderedRows?: number;
    /**
     * When `"failed"`, the list leads with what went wrong: errored resources,
     * then those still running when the apply stopped, then the completed ones,
     * each under its own heading. Otherwise it is one list in reported order.
     */
    outcome?: "succeeded" | "failed";
}

const FAILED_GROUPS: Array<{ status: ApplyResource["status"]; label: string }> = [
    { status: "errored", label: "Errored" },
    { status: "started", label: "Still running when the apply stopped" },
    { status: "complete", label: "Completed" },
];

/** The slowest few resources that reported a duration, slowest first. */
function slowest(resources: ApplyResource[]): Array<ApplyResource & { durationMs: number }> {
    return resources
        .filter((r): r is ApplyResource & { durationMs: number } => typeof r.durationMs === "number")
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, SLOWEST_SHOWN);
}

/** Per-resource apply status + duration, in the order the digest reported them. */
export function ApplyTimeline({ resources, appliedBeforeFailure, maxRenderedRows, outcome }: ApplyTimelineProps): JSX.Element {
    if (resources.length === 0) {
        return <div className="apply-timeline-empty">No resources were applied.</div>;
    }

    // Bounded rendering (§5.5): hard-cap the DOM rows for both the timeline and
    // the completed-before-failure list so a huge digest can't emit a row each.
    // A grouped (failed) timeline spends one budget across its groups in order,
    // so errored rows are never the ones cut.
    const maxRows = maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;
    const resourcesTruncated = resources.length > maxRows;
    const beforeFailure = appliedBeforeFailure ?? [];
    const beforeFailureTruncated = beforeFailure.length > maxRows;
    const shownBeforeFailure = beforeFailureTruncated ? beforeFailure.slice(0, maxRows) : beforeFailure;
    const slow = slowest(resources);

    const renderItem = (resource: ApplyResource, i: number): JSX.Element => {
        const duration = resource.durationMs === undefined ? null : formatDuration(resource.durationMs);
        return (
            <li key={`${resource.address}-${i}`} className={`apply-timeline-item status-${resource.status}`}>
                <span className="apply-timeline-address">{resource.address}</span>
                <span className="apply-timeline-action">{resource.action}</span>
                <span className="apply-timeline-status">{resource.status}</span>
                {duration && <span className="apply-timeline-duration">{duration}</span>}
            </li>
        );
    };

    let body: JSX.Element;
    if (outcome === "failed") {
        let budget = maxRows;
        body = (
            <React.Fragment>
                {FAILED_GROUPS.map(({ status, label }) => {
                    const members = resources.filter((r) => r.status === status);
                    const shown = members.slice(0, Math.max(budget, 0));
                    budget -= shown.length;
                    if (shown.length === 0) return null;
                    return (
                        <div key={status} className={`apply-timeline-group apply-timeline-group-${status}`}>
                            <div className="apply-timeline-group-heading">
                                {label} ({members.length})
                            </div>
                            <ul className="apply-timeline-list">{shown.map(renderItem)}</ul>
                        </div>
                    );
                })}
            </React.Fragment>
        );
    } else {
        const shownResources = resourcesTruncated ? resources.slice(0, maxRows) : resources;
        body = <ul className="apply-timeline-list">{shownResources.map(renderItem)}</ul>;
    }

    return (
        <div className="apply-timeline">
            {resourcesTruncated && (
                <div className="apply-timeline-truncated-banner">
                    List truncated to {maxRows} of {resources.length} resources.
                </div>
            )}
            {slow.length > 1 && (
                <div className="apply-timeline-slowest">
                    Slowest:{" "}
                    {slow.map((resource, i) => (
                        <React.Fragment key={`${resource.address}-${i}`}>
                            {i > 0 && ", "}
                            <span className="apply-timeline-address">{resource.address}</span> (
                            {formatDuration(resource.durationMs)})
                        </React.Fragment>
                    ))}
                </div>
            )}
            {body}
            {beforeFailure.length > 0 && (
                <div className="apply-timeline-before-failure">
                    <div>Completed before the apply errored:</div>
                    {beforeFailureTruncated && (
                        <div className="apply-timeline-truncated-banner">
                            List truncated to {maxRows} of {beforeFailure.length} addresses.
                        </div>
                    )}
                    <ul>
                        {shownBeforeFailure.map((address, i) => (
                            <li key={`${address}-${i}`}>{address}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
