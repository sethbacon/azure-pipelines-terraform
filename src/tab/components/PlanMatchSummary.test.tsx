import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanMatchSummary } from "./PlanMatchSummary";
import { PlanMatch } from "../plan-match";

const EXACT: PlanMatch = { unplanned: [], notApplied: [], differentAction: [], complete: true };

describe("PlanMatchSummary", () => {
  it("says an apply matches its plan", () => {
    const html = renderToStaticMarkup(<PlanMatchSummary perspective="apply" otherName="prod" match={EXACT} onOpen={jest.fn()} />);
    expect(html).toContain('class="plan-match plan-match-ok"');
    expect(html).toContain('Matches plan <span class="plan-match-name">prod</span>');
    expect(html).toContain(">Open plan</button>");
  });

  it("lists how an apply differs from its plan", () => {
    const match: PlanMatch = {
      unplanned: ["aws_instance.surprise"],
      notApplied: ["aws_instance.a", "aws_instance.b"],
      differentAction: [{ address: "aws_instance.c", planned: "update", applied: "replace" }],
      complete: true,
    };
    const html = renderToStaticMarkup(<PlanMatchSummary perspective="apply" otherName="prod" match={match} onOpen={jest.fn()} />);
    expect(html).toContain('class="plan-match plan-match-differs"');
    expect(html).toContain("Differs from plan");
    expect(html).toContain("1 change wasn&#x27;t in the plan:");
    expect(html).toContain("2 planned changes weren&#x27;t applied:");
    expect(html).toContain("aws_instance.c: planned update, applied replace");
  });

  it("from the plan's side, names the apply and how it ended", () => {
    const html = renderToStaticMarkup(
      <PlanMatchSummary perspective="plan" otherName="prod" match={EXACT} applyOutcome="failed" onOpen={jest.fn()} />
    );
    expect(html).toContain('Applied by <span class="plan-match-name">prod</span> (failed), as planned');
    expect(html).toContain(">Open apply</button>");
  });

  it("caps long address lists and flags an incomplete comparison", () => {
    const many = Array.from({ length: 25 }, (_, i) => `aws_instance.r${i}`);
    const html = renderToStaticMarkup(
      <PlanMatchSummary perspective="apply" otherName="prod" match={{ ...EXACT, unplanned: many, complete: false }} onOpen={jest.fn()} />
    );
    expect(html).toContain("aws_instance.r19");
    expect(html).not.toContain("aws_instance.r20<");
    expect(html).toContain("and 5 more");
    expect(html).toContain("may be incomplete");
  });

  it("opens the other item", () => {
    const onOpen = jest.fn();
    const el = PlanMatchSummary({ perspective: "apply", otherName: "prod", match: EXACT, onOpen }) as React.ReactElement;
    const headline = (el.props as { children: React.ReactElement[] }).children[0];
    const button = (headline.props as { children: React.ReactElement[] }).children[2];
    (button.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("HTML-escapes the other item's name", () => {
    const html = renderToStaticMarkup(<PlanMatchSummary perspective="apply" otherName="<img src=x>" match={EXACT} onOpen={jest.fn()} />);
    expect(html).not.toContain("<img src=x>");
  });
});
