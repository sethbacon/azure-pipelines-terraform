import * as React from "react";
import { AttentionItem, Pivot } from "../attention";

const PIVOT_LABELS: Record<Pivot, string> = { plan: "Plan", apply: "Apply", state: "State" };

/** More than this many entries collapse into an "and N more" line. */
const DEFAULT_MAX_SHOWN = 8;

export interface AttentionStripProps {
    items: AttentionItem[];
    /** Opens the item: switches to its pivot and selects it. */
    onSelect: (pivot: Pivot, id: string) => void;
    maxShown?: number;
}

/**
 * The run's "needs review" list, above the pivots: failed applies, plans that
 * destroy, digests that can't be read or are incomplete, and drift. Each entry
 * is a button that opens that item. Renders nothing when there is nothing to
 * flag. Item names are untrusted and rendered as text nodes; reasons are built
 * from counts and fixed wording (see attention.ts).
 */
export function AttentionStrip({ items, onSelect, maxShown = DEFAULT_MAX_SHOWN }: AttentionStripProps): JSX.Element | null {
    if (items.length === 0) return null;
    const shown = items.slice(0, maxShown);

    return (
        <section className="attention-strip" aria-label="Needs review">
            <div className="attention-strip-title">Needs review ({items.length})</div>
            <ul className="attention-strip-list">
                {shown.map((item) => (
                    <li key={`${item.pivot}:${item.id}`} className={`attention-item attention-${item.severity}`}>
                        <button type="button" className="attention-item-open" onClick={() => onSelect(item.pivot, item.id)}>
                            <span className="attention-item-pivot">{PIVOT_LABELS[item.pivot]}</span>{" "}
                            <span className="attention-item-name">{item.name}</span>
                            <span className="attention-item-reason">: {item.reason}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {items.length > shown.length && (
                <div className="attention-strip-more">and {items.length - shown.length} more</div>
            )}
        </section>
    );
}
