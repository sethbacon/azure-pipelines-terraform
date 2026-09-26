import * as React from "react";
import { RedactedValue } from "../digest-schema";
import { formatRedactedValue } from "./redacted-value";
import { SENTINELS } from "../value-diff";

/** Longest JSON text shown for one value inside a structural diff before it is cut off. */
const MAX_INLINE_CHARS = 300;

/**
 * A RedactedValue as display text. The placeholders — "(sensitive)",
 * "(known after apply)", "(value omitted: too large)" — are styled apart from
 * real values so a masked value can't be mistaken for a literal one.
 */
export function RedactedValueText({ value }: { value: RedactedValue }): JSX.Element {
    const text = formatRedactedValue(value);
    return value.kind === "value" ? <React.Fragment>{text}</React.Fragment> : <span className="value-placeholder">{text}</span>;
}

/**
 * One value inside a structural diff, as compact JSON. A string that is one of
 * the task's sentinels ("(sensitive)", "(known after apply)") is styled as a
 * placeholder: a literal string with that exact text would be styled the same,
 * which can only make a real value look masked, never the reverse.
 */
export function JsonValueText({ value }: { value: unknown }): JSX.Element {
    if (typeof value === "string" && SENTINELS.has(value)) return <span className="value-placeholder">{value}</span>;
    const text = JSON.stringify(value) ?? "null";
    return <React.Fragment>{text.length > MAX_INLINE_CHARS ? `${text.slice(0, MAX_INLINE_CHARS)}…` : text}</React.Fragment>;
}
