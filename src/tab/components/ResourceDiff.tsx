import * as React from "react";
import { PlanResource } from "../digest-schema";
import { formatRedactedValue } from "./redacted-value";

export interface ResourceDiffProps {
    resource: PlanResource;
    /**
     * `"card"` (default) repeats the address/type/actions header and the action
     * reason, for a diff shown on its own (drift). `"inline"` drops both, for a
     * diff expanded directly under the resource row, which already shows them.
     */
    variant?: "card" | "inline";
}

/**
 * Before → after attribute diff table for a single plan resource. Every
 * digest string (address, path, redacted-value text) is rendered as a React
 * text node — see `formatRedactedValue`, which only ever returns the
 * already-redacted `json` text or a fixed placeholder.
 */
export function ResourceDiff({ resource, variant = "card" }: ResourceDiffProps): JSX.Element {
    const inline = variant === "inline";
    return (
        <div className={`resource-diff${inline ? " resource-diff-inline" : ""}`}>
            {!inline && (
                <div className="resource-diff-header">
                    <span className="resource-diff-address">{resource.address}</span>
                    <span className="resource-diff-type">{resource.type}</span>
                    <span className="resource-diff-actions">{resource.actions.join(", ")}</span>
                </div>
            )}
            {!inline && resource.actionReason && (
                <div className="resource-diff-reason">Reason: {resource.actionReason}</div>
            )}
            {resource.replacePaths && resource.replacePaths.length > 0 && (
                <div className="resource-diff-replace-paths">
                    Forces replacement: {resource.replacePaths.join(", ")}
                </div>
            )}
            {resource.attributeChanges.length === 0 ? (
                <div className="resource-diff-empty">No attribute changes recorded for this resource.</div>
            ) : (
                <table className="resource-diff-table">
                    <thead>
                        <tr>
                            <th>Attribute</th>
                            <th>Before</th>
                            <th>After</th>
                        </tr>
                    </thead>
                    <tbody>
                        {resource.attributeChanges.map((change) => (
                            <tr key={change.path}>
                                <td className="resource-diff-path">{change.path}</td>
                                <td className="resource-diff-before">{formatRedactedValue(change.before)}</td>
                                <td className="resource-diff-after">{formatRedactedValue(change.after)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
