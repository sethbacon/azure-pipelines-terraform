import * as React from "react";

export interface SectionProps {
    /** Fixed heading text supplied by the tab itself — never digest content. */
    title: string;
    /**
     * Count or short qualifier shown after the title in parentheses, e.g. `40`,
     * `"2 errors, 1 warning"`, or an attachment name. May be untrusted; like
     * everything else it is rendered as a text node.
     */
    count?: number | string;
    open: boolean;
    onToggle: () => void;
    /**
     * Render prop, called only while the section is open, so a collapsed section
     * costs nothing: its subtree is never built, not merely hidden.
     */
    children: () => React.ReactNode;
    /** Extra class for section-specific styling. */
    className?: string;
}

/**
 * A titled, collapsible part of a digest detail view. The heading is a real
 * `<button aria-expanded>` (the disclosure pattern), so it is keyboard- and
 * screen-reader-operable without extra handling. Fully controlled, like the
 * tab's other components: the caller owns `open`, so the section renders
 * deterministically from props.
 */
export function Section({ title, count, open, onToggle, children, className }: SectionProps): JSX.Element {
    return (
        <section className={`detail-section${className ? ` ${className}` : ""}`}>
            <h3 className="detail-section-heading">
                <button type="button" className="detail-section-toggle" aria-expanded={open} onClick={onToggle}>
                    <span className="disclosure-chevron" aria-hidden="true" />
                    {title}
                    {count !== undefined && <span className="detail-section-count"> ({count})</span>}
                </button>
            </h3>
            {open && <div className="detail-section-body">{children()}</div>}
        </section>
    );
}
