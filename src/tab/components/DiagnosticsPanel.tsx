import * as React from "react";
import { Diagnostic } from "../digest-schema";

export interface DiagnosticsPanelProps {
    diagnostics: Diagnostic[];
}

/**
 * Apply/plan diagnostics list, errors first. `summary`/`detail` are freeform
 * text the task has already scrubbed (spec §5.4) but the tab still renders
 * them purely as React text nodes — never as HTML.
 */
export function DiagnosticsPanel({ diagnostics }: DiagnosticsPanelProps): JSX.Element {
    if (diagnostics.length === 0) {
        return <div className="diagnostics-panel-empty">No diagnostics.</div>;
    }

    const sorted = [...diagnostics].sort((a, b) => {
        if (a.severity === b.severity) return 0;
        return a.severity === "error" ? -1 : 1;
    });

    return (
        <ul className="diagnostics-panel">
            {sorted.map((diagnostic, i) => (
                <li key={i} className={`diagnostics-panel-item severity-${diagnostic.severity}`}>
                    <span className="diagnostics-panel-severity">{diagnostic.severity}</span>
                    <span className="diagnostics-panel-summary">{diagnostic.summary}</span>
                    {diagnostic.address && <span className="diagnostics-panel-address">{diagnostic.address}</span>}
                    {diagnostic.detail && (
                        <div className="diagnostics-panel-detail">{diagnostic.detail}</div>
                    )}
                </li>
            ))}
        </ul>
    );
}
