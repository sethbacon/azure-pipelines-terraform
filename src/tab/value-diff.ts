/**
 * What changed inside a structured attribute value.
 *
 * An attribute such as `tags`, a nested block, or a JSON policy document is a
 * whole map or list in the digest, and showing both versions in full hides a
 * one-key change in a wall of JSON. This compares the two and lists only the
 * keys and elements that differ.
 *
 * Input is the `json` of an already-redacted `{kind:"value"}` RedactedValue:
 * sensitive and unknown leaves inside it are already the literal strings
 * "(sensitive)" / "(known after apply)", so nothing here can reveal more than
 * the digest does. Values are only read (Object.keys, own-property checks),
 * never assigned by key, so a key like `__proto__` is just text.
 */

/** Past this depth a changed value is shown whole rather than compared further. */
const MAX_DEPTH = 4;

/** Past this many entries the rest are counted, not listed. */
export const MAX_DIFF_ENTRIES = 200;

export type DiffEntry =
    | { kind: "added"; path: string; value: unknown }
    | { kind: "removed"; path: string; value: unknown }
    | { kind: "changed"; path: string; before: unknown; after: unknown };

export interface StructuredDiff {
    entries: DiffEntry[];
    /** Entries beyond MAX_DIFF_ENTRIES, not listed. */
    more: number;
    /** Keys or elements compared and found equal. */
    unchanged: number;
    /** True when both sides were JSON documents held in strings (e.g. an IAM policy). */
    fromStrings: boolean;
}

type Container = Record<string, unknown> | unknown[];

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isContainer(v: unknown): v is Container {
    return v !== null && typeof v === "object";
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    if (isObject(a) && isObject(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
    }
    return false;
}

/** A JSON container from a RedactedValue's json, looking inside a string that itself holds a JSON document. */
function parseContainer(json: string): { value: Container; fromString: boolean } | null {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch {
        return null; // e.g. a value the tab truncated at its size cap
    }
    if (isContainer(value)) return { value, fromString: false };
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                const inner: unknown = JSON.parse(trimmed);
                if (isContainer(inner)) return { value: inner, fromString: true };
            } catch {
                return null;
            }
        }
    }
    return null;
}

function childPath(prefix: string, key: string): string {
    return prefix ? `${prefix}.${key}` : key;
}

function compare(prefix: string, a: unknown, b: unknown, depth: number, out: { entries: DiffEntry[]; unchanged: number }): void {
    if (deepEqual(a, b)) {
        out.unchanged++;
        return;
    }
    if (depth < MAX_DEPTH && isObject(a) && isObject(b)) {
        const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
        for (const key of keys) {
            const path = childPath(prefix, key);
            if (!hasOwn(b, key)) out.entries.push({ kind: "removed", path, value: a[key] });
            else if (!hasOwn(a, key)) out.entries.push({ kind: "added", path, value: b[key] });
            else compare(path, a[key], b[key], depth + 1, out);
        }
        return;
    }
    if (depth < MAX_DEPTH && Array.isArray(a) && Array.isArray(b)) {
        if (a.length === b.length) {
            // Same length: element by element (a single nested block is a one-element list).
            a.forEach((item, i) => compare(`${prefix}[${i}]`, item, b[i], depth + 1, out));
            return;
        }
        // Different lengths: which elements were added or removed, ignoring order.
        const remaining = b.map((item) => JSON.stringify(item));
        for (const item of a) {
            const at = remaining.indexOf(JSON.stringify(item));
            if (at >= 0) {
                remaining.splice(at, 1);
                out.unchanged++;
            } else {
                out.entries.push({ kind: "removed", path: `${prefix}[]`, value: item });
            }
        }
        for (const text of remaining) out.entries.push({ kind: "added", path: `${prefix}[]`, value: JSON.parse(text) as unknown });
        return;
    }
    out.entries.push({ kind: "changed", path: prefix, before: a, after: b });
}

/**
 * The differences between two redacted JSON values when both are maps or both
 * are lists (directly, or as JSON documents inside strings); null when they
 * aren't, so the caller shows the two values side by side instead.
 */
export function diffStructured(beforeJson: string, afterJson: string): StructuredDiff | null {
    const before = parseContainer(beforeJson);
    const after = parseContainer(afterJson);
    if (!before || !after || Array.isArray(before.value) !== Array.isArray(after.value)) return null;

    const out = { entries: [] as DiffEntry[], unchanged: 0 };
    compare("", before.value, after.value, 0, out);
    const more = Math.max(0, out.entries.length - MAX_DIFF_ENTRIES);
    return {
        entries: more > 0 ? out.entries.slice(0, MAX_DIFF_ENTRIES) : out.entries,
        more,
        unchanged: out.unchanged,
        fromStrings: before.fromString && after.fromString,
    };
}

/** Placeholders the task writes for sensitive and unknown leaves inside a value. */
export const SENTINELS: ReadonlySet<string> = new Set(["(sensitive)", "(known after apply)"]);
