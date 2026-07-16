import * as React from "react";
import { ApplyResource } from "../digest-schema";

export interface ApplyTimelineProps {
    resources: ApplyResource[];
    appliedBeforeFailure?: string[];
}

function formatDuration(ms: number | undefined): string | null {
    if (ms === undefined) return null;
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Per-resource apply status + duration, in the order the digest reported them. */
export function ApplyTimeline({ resources, appliedBeforeFailure }: ApplyTimelineProps): JSX.Element {
    if (resources.length === 0) {
        return <div className="apply-timeline-empty">No resources were applied.</div>;
    }

    return (
        <div className="apply-timeline">
            <ul className="apply-timeline-list">
                {resources.map((resource, i) => {
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
            {appliedBeforeFailure && appliedBeforeFailure.length > 0 && (
                <div className="apply-timeline-before-failure">
                    <div>Completed before the apply errored:</div>
                    <ul>
                        {appliedBeforeFailure.map((address) => (
                            <li key={address}>{address}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
