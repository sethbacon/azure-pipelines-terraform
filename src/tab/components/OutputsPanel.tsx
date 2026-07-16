import * as React from "react";
import { OutputChange } from "../digest-schema";
import { TAB_MAX_RENDERED_ROWS } from "../caps";
import { formatRedactedValue } from "./redacted-value";

export interface OutputsPanelProps {
    outputs: OutputChange[];
    maxRenderedRows?: number;
}

/** Masked outputs list (plan `outputChanges` or apply `outputs`). */
export function OutputsPanel({ outputs, maxRenderedRows }: OutputsPanelProps): JSX.Element {
    if (outputs.length === 0) {
        return <div className="outputs-panel-empty">No outputs.</div>;
    }

    // Bounded rendering (§5.5): hard-cap the DOM rows so a digest that claims a
    // huge output list can't emit one element per row.
    const maxRows = maxRenderedRows ?? TAB_MAX_RENDERED_ROWS;
    const truncated = outputs.length > maxRows;
    const shown = truncated ? outputs.slice(0, maxRows) : outputs;

    return (
        <div className="outputs-panel-wrap">
            {truncated && (
                <div className="outputs-panel-truncated-banner">
                    List truncated to {maxRows} of {outputs.length} outputs.
                </div>
            )}
            <table className="outputs-panel">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Action</th>
                        <th>Value</th>
                    </tr>
                </thead>
                <tbody>
                    {shown.map((output) => (
                        <tr key={output.name}>
                            <td className="outputs-panel-name">{output.name}</td>
                            <td className="outputs-panel-action">{output.action}</td>
                            <td className="outputs-panel-value">{formatRedactedValue(output.value)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
