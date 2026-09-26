import * as React from "react";
import { AttrChange, PlanResource, RedactedValue } from "../digest-schema";
import { describeActionReason } from "../action-reason";
import { diffStructured } from "../value-diff";
import { RedactedValueText } from "./ValueText";
import { ValueDiff } from "./ValueDiff";

export interface ResourceDiffProps {
    resource: PlanResource;
    /**
     * `"card"` (default) repeats the address/type/actions header and the action
     * reason, for a diff shown on its own (drift). `"inline"` drops both, for a
     * diff expanded directly under the resource row, which already shows them.
     */
    variant?: "card" | "inline";
    /**
     * `"drift"` compares what Terraform's state recorded with what the provider
     * found, so the columns read "In state" / "Actual" rather than
     * "Before" / "After", and there are no actions to show.
     */
    mode?: "plan" | "drift";
}

function isNull(value: RedactedValue): boolean {
    return value.kind === "value" && value.json === "null";
}

/** Whether `replacePath` (e.g. `site_config[0].image`) is inside the top-level attribute `path`. */
function forcesReplacement(path: string, replacePaths: string[]): boolean {
    return replacePaths.some((p) => p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}[`));
}

/**
 * The attribute changes of one resource. Every digest string (address, path,
 * redacted-value text) is rendered as a React text node.
 *
 * - A resource being created shows each attribute's new value, and one being
 *   destroyed its current value, rather than a column of `null`s.
 * - Attributes that force replacement (`replace_paths`) are tagged in place.
 * - For a changed map, list or nested block, the rows show only what differs
 *   (see value-diff.ts), with both full values behind a disclosure.
 */
export function ResourceDiff({ resource, variant = "card", mode = "plan" }: ResourceDiffProps): JSX.Element {
    const inline = variant === "inline";
    const drift = mode === "drift";
    const changes = resource.attributeChanges;
    const replacePaths = resource.replacePaths ?? [];
    const creating = !drift && changes.length > 0 && changes.every((c) => isNull(c.before));
    const destroying = !drift && changes.length > 0 && changes.every((c) => isNull(c.after));
    const singleColumn = creating || destroying;
    const unmatchedReplacePaths = replacePaths.filter((p) => !changes.some((c) => forcesReplacement(c.path, [p])));

    const pathCell = (change: AttrChange): JSX.Element => (
        <td className="resource-diff-path">
            {change.path}
            {forcesReplacement(change.path, replacePaths) && <span className="forces-replacement">forces replacement</span>}
        </td>
    );

    const valueCells = (change: AttrChange): JSX.Element => {
        if (singleColumn) {
            return (
                <td className={creating ? "resource-diff-after" : "resource-diff-before"} colSpan={2}>
                    <RedactedValueText value={creating ? change.after : change.before} />
                </td>
            );
        }
        const structured =
            change.before.kind === "value" && change.after.kind === "value" ? diffStructured(change.before.json, change.after.json) : null;
        if (structured) {
            return (
                <td className="resource-diff-structured" colSpan={2}>
                    <ValueDiff diff={structured} />
                    <details className="resource-diff-full">
                        <summary>Full values</summary>
                        <div className="resource-diff-before">
                            <RedactedValueText value={change.before} />
                        </div>
                        <div className="resource-diff-after">
                            <RedactedValueText value={change.after} />
                        </div>
                    </details>
                </td>
            );
        }
        return (
            <React.Fragment>
                <td className="resource-diff-before">
                    <RedactedValueText value={change.before} />
                </td>
                <td className="resource-diff-after">
                    <RedactedValueText value={change.after} />
                </td>
            </React.Fragment>
        );
    };

    return (
        <div className={`resource-diff${inline ? " resource-diff-inline" : ""}`}>
            {!inline && (
                <div className="resource-diff-header">
                    <span className="resource-diff-address">{resource.address}</span>
                    <span className="resource-diff-type">{resource.type}</span>
                    {!drift && <span className="resource-diff-actions">{resource.actions.join(", ")}</span>}
                </div>
            )}
            {!inline && resource.actionReason && (
                <div className="resource-diff-reason">Reason: {describeActionReason(resource.actionReason)}</div>
            )}
            {unmatchedReplacePaths.length > 0 && (
                <div className="resource-diff-replace-paths">Forces replacement: {unmatchedReplacePaths.join(", ")}</div>
            )}
            {changes.length === 0 ? (
                <div className="resource-diff-empty">No attribute changes recorded for this resource.</div>
            ) : (
                <table className="resource-diff-table">
                    <thead>
                        <tr>
                            <th>Attribute</th>
                            {singleColumn ? (
                                <th colSpan={2}>{creating ? "Value" : "Current value"}</th>
                            ) : (
                                <React.Fragment>
                                    <th>{drift ? "In state" : "Before"}</th>
                                    <th>{drift ? "Actual" : "After"}</th>
                                </React.Fragment>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {changes.map((change) => (
                            <tr key={change.path}>
                                {pathCell(change)}
                                {valueCells(change)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
