import * as React from "react";
import { PlanMatch, isExactMatch } from "../plan-match";

/** Addresses listed per kind of difference before the rest are counted. */
const MAX_LISTED = 20;

export interface PlanMatchSummaryProps {
    /** Which side is being viewed: an apply compared with its plan, or a plan with its apply. */
    perspective: "apply" | "plan";
    /** The other item's name (untrusted, rendered as text). */
    otherName: string;
    match: PlanMatch;
    /** For the plan perspective: how the apply ended. */
    applyOutcome?: "succeeded" | "failed";
    /** Opens the other item. */
    onOpen: () => void;
}

function AddressList({ addresses }: { addresses: string[] }): JSX.Element {
    return (
        <ul className="plan-match-list">
            {addresses.slice(0, MAX_LISTED).map((address, i) => (
                <li key={`${address}-${i}`}>{address}</li>
            ))}
            {addresses.length > MAX_LISTED && <li>and {addresses.length - MAX_LISTED} more</li>}
        </ul>
    );
}

/**
 * Whether an apply did what its plan (same name, same run) said: matches, or
 * which changes weren't planned, weren't applied, or were applied differently.
 */
export function PlanMatchSummary({ perspective, otherName, match, applyOutcome, onOpen }: PlanMatchSummaryProps): JSX.Element {
    const exact = isExactMatch(match);
    const open = (
        <button type="button" className="plan-match-open" onClick={onOpen}>
            {perspective === "apply" ? "Open plan" : "Open apply"}
        </button>
    );

    const headline =
        perspective === "apply" ? (
            <React.Fragment>
                {exact ? "Matches plan " : "Differs from plan "}
                <span className="plan-match-name">{otherName}</span>
            </React.Fragment>
        ) : (
            <React.Fragment>
                {"Applied by "}
                <span className="plan-match-name">{otherName}</span>
                {applyOutcome === "failed" ? " (failed)" : ""}
                {exact ? ", as planned" : ", with differences"}
            </React.Fragment>
        );

    return (
        <div className={`plan-match ${exact ? "plan-match-ok" : "plan-match-differs"}`} role="note">
            <div className="plan-match-headline">
                {headline} {open}
            </div>
            {match.unplanned.length > 0 && (
                <div className="plan-match-group">
                    {match.unplanned.length} {match.unplanned.length === 1 ? "change wasn't" : "changes weren't"} in the plan:
                    <AddressList addresses={match.unplanned} />
                </div>
            )}
            {match.notApplied.length > 0 && (
                <div className="plan-match-group">
                    {match.notApplied.length} planned {match.notApplied.length === 1 ? "change wasn't" : "changes weren't"} applied:
                    <AddressList addresses={match.notApplied} />
                </div>
            )}
            {match.differentAction.length > 0 && (
                <div className="plan-match-group">
                    {match.differentAction.length} {match.differentAction.length === 1 ? "was" : "were"} applied differently:
                    <ul className="plan-match-list">
                        {match.differentAction.slice(0, MAX_LISTED).map((d, i) => (
                            <li key={`${d.address}-${i}`}>
                                {d.address}: planned {d.planned}, applied {d.applied}
                            </li>
                        ))}
                        {match.differentAction.length > MAX_LISTED && <li>and {match.differentAction.length - MAX_LISTED} more</li>}
                    </ul>
                </div>
            )}
            {!match.complete && (
                <div className="plan-match-note">One of the two digests was truncated, so this comparison may be incomplete.</div>
            )}
        </div>
    );
}
