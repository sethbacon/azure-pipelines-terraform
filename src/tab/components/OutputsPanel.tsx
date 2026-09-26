import * as React from "react";
import { OutputChange, OutputValue } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";
import { formatRedactedValue } from "./redacted-value";

/** `OutputValue` has no `action`; only its `OutputChange` extension does. Read it defensively without an unsafe cast. */
function outputAction(output: OutputValue): OutputChange["action"] | undefined {
    const action = (output as Partial<OutputChange>).action;
    return typeof action === "string" ? action : undefined;
}

export interface OutputsPanelProps {
    /**
     * Plan `outputChanges` / apply `outputs` are `OutputChange[]` (carry an
     * `action`); state `outputs` (digest spec §7.3) are `OutputValue[]` (no
     * `action` — a point-in-time inventory, not a change set). `OutputChange`
     * extends `OutputValue`, so either is assignable here; the Action column
     * is only rendered when at least one item actually has an `action`.
     */
    outputs: OutputValue[];
    maxRenderedRows?: number;
    /**
     * Plan output changes only. When set, outputs whose action is `no-op` are
     * collapsed behind a "Show N unchanged" toggle (open while `showUnchanged`),
     * so the panel leads with what the plan changes. Leave it unset for apply and
     * state outputs, which are current values rather than a change set.
     */
    onToggleUnchanged?: () => void;
    showUnchanged?: boolean;
}

/** Masked outputs list (plan `outputChanges`, apply `outputs`, or state `outputs`). */
export function OutputsPanel({ outputs, maxRenderedRows, onToggleUnchanged, showUnchanged = false }: OutputsPanelProps): JSX.Element {
    if (outputs.length === 0) {
        return <div className="outputs-panel-empty">No outputs.</div>;
    }

    const collapsible = onToggleUnchanged !== undefined;
    const unchangedCount = collapsible ? outputs.filter((output) => outputAction(output) === "no-op").length : 0;
    const listed = collapsible && !showUnchanged ? outputs.filter((output) => outputAction(output) !== "no-op") : outputs;

    // Bounded rendering (§5.5): hard-cap the DOM rows so a digest that claims a
    // huge output list can't emit one element per row.
    const maxRows = maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;
    const truncated = listed.length > maxRows;
    const shown = truncated ? listed.slice(0, maxRows) : listed;

    // Plan/apply outputs (OutputChange) carry an `action`; state outputs
    // (OutputValue, digest spec §7.3) do not, since state is a point-in-time
    // inventory, not a change set. Only render the Action column when there's
    // an action to show.
    const hasActions = shown.some((output) => outputAction(output) !== undefined);

    return (
        <div className="outputs-panel-wrap">
            {truncated && (
                <div className="outputs-panel-truncated-banner">
                    List truncated to {maxRows} of {listed.length} outputs.
                </div>
            )}
            {shown.length === 0 ? (
                <div className="outputs-panel-empty">No output changes.</div>
            ) : (
                <table className="outputs-panel">
                    <thead>
                        <tr>
                            <th>Name</th>
                            {hasActions && <th>Action</th>}
                            <th>Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((output) => (
                            <tr key={output.name}>
                                <td className="outputs-panel-name">{output.name}</td>
                                {hasActions && <td className="outputs-panel-action">{outputAction(output) ?? ""}</td>}
                                <td className="outputs-panel-value">{formatRedactedValue(output.value)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {unchangedCount > 0 && (
                <button type="button" className="outputs-panel-toggle" aria-expanded={showUnchanged} onClick={onToggleUnchanged}>
                    {showUnchanged ? "Hide" : "Show"} {unchangedCount} unchanged {unchangedCount === 1 ? "output" : "outputs"}
                </button>
            )}
        </div>
    );
}
