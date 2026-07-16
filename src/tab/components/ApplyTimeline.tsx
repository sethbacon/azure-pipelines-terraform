import * as React from "react";
import { ApplyResource } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";

export interface ApplyTimelineProps {
    resources: ApplyResource[];
    appliedBeforeFailure?: string[];
    maxRenderedRows?: number;
}

function formatDuration(ms: number | undefined): string | null {
    if (ms === undefined) return null;
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Per-resource apply status + duration, in the order the digest reported them. */
export function ApplyTimeline({ resources, appliedBeforeFailure, maxRenderedRows }: ApplyTimelineProps): JSX.Element {
    if (resources.length === 0) {
        return <div className="apply-timeline-empty">No resources were applied.</div>;
    }

    // Bounded rendering (§5.5): hard-cap the DOM rows for both the timeline and
    // the completed-before-failure list so a huge digest can't emit a row each.
    const maxRows = maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;
    const resourcesTruncated = resources.length > maxRows;
    const shownResources = resourcesTruncated ? resources.slice(0, maxRows) : resources;
    const beforeFailure = appliedBeforeFailure ?? [];
    const beforeFailureTruncated = beforeFailure.length > maxRows;
    const shownBeforeFailure = beforeFailureTruncated ? beforeFailure.slice(0, maxRows) : beforeFailure;

    return (
        <div className="apply-timeline">
            {resourcesTruncated && (
                <div className="apply-timeline-truncated-banner">
                    List truncated to {maxRows} of {resources.length} resources.
                </div>
            )}
            <ul className="apply-timeline-list">
                {shownResources.map((resource, i) => {
                    const duration = formatDuration(resource.durationMs);
                    return (
                        <li key={`${resource.address}-${i}`} className={`apply-timeline-item status-${resource.status}`}>
                            <span className="apply-timeline-address">{resource.address}</span>
                            <span className="apply-timeline-action">{resource.action}</span>
                            <span className="apply-timeline-status">{resource.status}</span>
                            {duration && <span className="apply-timeline-duration">{duration}</span>}
                        </li>
                    );
                })}
            </ul>
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
