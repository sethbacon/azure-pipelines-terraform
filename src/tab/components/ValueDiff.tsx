import * as React from "react";
import { StructuredDiff } from "../value-diff";
import { JsonValueText } from "./ValueText";

const SIGNS = { added: "+", removed: "-", changed: "~" } as const;

/** The path as shown: the attribute's own list members read "item", and the whole value "(value)". */
function pathLabel(path: string): string {
    if (path === "") return "(value)";
    return path === "[]" ? "item" : path;
}

export interface ValueDiffProps {
    diff: StructuredDiff;
}

/**
 * The keys and elements that differ between two versions of a map, list or
 * nested block (see value-diff.ts), Terraform-style: `+` added, `-` removed,
 * `~` changed, then a count of what stayed the same. Every value is a text node.
 */
export function ValueDiff({ diff }: ValueDiffProps): JSX.Element {
    const { entries, more, unchanged, fromStrings } = diff;
    return (
        <div className="value-diff">
            {fromStrings && <div className="value-diff-note">JSON document inside a string</div>}
            {entries.length === 0 ? (
                <div className="value-diff-note">
                    No visible difference; a sensitive or not-yet-known value inside it may have changed.
                </div>
            ) : (
                <ul className="value-diff-list">
                    {entries.map((entry, i) => (
                        <li key={i} className={`value-diff-entry value-diff-${entry.kind}`}>
                            <span className="value-diff-sign" aria-hidden="true">
                                {SIGNS[entry.kind]}
                            </span>{" "}
                            <span className="value-diff-path">{pathLabel(entry.path)}</span>
                            {entry.kind === "changed" ? (
                                <React.Fragment>
                                    {": "}
                                    <span className="value-diff-before">
                                        <JsonValueText value={entry.before} />
                                    </span>
                                    {" → "}
                                    <span className="value-diff-after">
                                        <JsonValueText value={entry.after} />
                                    </span>
                                </React.Fragment>
                            ) : (
                                <React.Fragment>
                                    {entry.kind === "added" ? " added: " : " removed: "}
                                    <span className={entry.kind === "added" ? "value-diff-after" : "value-diff-before"}>
                                        <JsonValueText value={entry.value} />
                                    </span>
                                </React.Fragment>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {(more > 0 || unchanged > 0) && (
                <div className="value-diff-note">
                    {more > 0 && `and ${more} more ${more === 1 ? "change" : "changes"}`}
                    {more > 0 && unchanged > 0 && "; "}
                    {unchanged > 0 && `${unchanged} unchanged`}
                </div>
            )}
        </div>
    );
}
