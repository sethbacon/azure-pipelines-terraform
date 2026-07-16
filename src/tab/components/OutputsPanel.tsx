import * as React from "react";
import { OutputChange } from "../digest-schema";
import { formatRedactedValue } from "./redacted-value";

export interface OutputsPanelProps {
    outputs: OutputChange[];
}

/** Masked outputs list (plan `outputChanges` or apply `outputs`). */
export function OutputsPanel({ outputs }: OutputsPanelProps): JSX.Element {
    if (outputs.length === 0) {
        return <div className="outputs-panel-empty">No outputs.</div>;
    }

    return (
        <table className="outputs-panel">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Action</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
                {outputs.map((output) => (
                    <tr key={output.name}>
                        <td className="outputs-panel-name">{output.name}</td>
                        <td className="outputs-panel-action">{output.action}</td>
                        <td className="outputs-panel-value">{formatRedactedValue(output.value)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
