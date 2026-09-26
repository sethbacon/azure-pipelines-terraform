import * as React from "react";
import { DriftResource, PlanResource } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";
import { ResourceDiff } from "./ResourceDiff";

/** Adapts a DriftResource (no `actions`/`actionReason`/`replacePaths`) into the PlanResource shape ResourceDiff renders. */
function driftAsPlanResource(drift: DriftResource): PlanResource {
    return { ...drift, actions: [] };
}

export interface DriftListProps {
    drift: DriftResource[];
    maxRenderedRows?: number;
}

/**
 * Resources whose real-world state changed outside Terraform (`resource_drift`),
 * one attribute diff per resource. Bounded like every other list (§5.5): a digest
 * can carry up to MAX_DRIFT entries, each with its own table.
 */
export function DriftList({ drift, maxRenderedRows }: DriftListProps): JSX.Element {
    const maxRows = maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;
    const truncated = drift.length > maxRows;
    const shown = truncated ? drift.slice(0, maxRows) : drift;

    return (
        <div className="drift-list">
            <p className="drift-list-intro">
                Changes made outside Terraform since the last apply, detected while refreshing state for this plan.
            </p>
            {truncated && (
                <div className="drift-section-truncated-banner">
                    List truncated to {maxRows} of {drift.length} drifted resources.
                </div>
            )}
            {shown.map((d) => (
                <ResourceDiff key={d.address} resource={driftAsPlanResource(d)} mode="drift" />
            ))}
        </div>
    );
}
