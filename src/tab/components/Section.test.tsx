import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Section, SectionProps } from "./Section";

function props(overrides: Partial<SectionProps> = {}): SectionProps {
  return {
    title: "Drift",
    open: true,
    onToggle: jest.fn(),
    children: () => <p>section body</p>,
    ...overrides,
  };
}

describe("Section", () => {
  it("renders its title and count in a disclosure button, with the body when open", () => {
    const html = renderToStaticMarkup(<Section {...props({ count: 40 })} />);
    expect(html).toContain('<button type="button" class="detail-section-toggle" aria-expanded="true">');
    expect(html).toContain("Drift");
    expect(html).toContain('<span class="detail-section-count"> (40)</span>');
    expect(html).toContain("section body");
  });

  it("accepts a text summary as the count", () => {
    const html = renderToStaticMarkup(<Section {...props({ count: "2 errors, 1 warning" })} />);
    expect(html).toContain("(2 errors, 1 warning)");
  });

  it("omits the count when none is given", () => {
    const html = renderToStaticMarkup(<Section {...props()} />);
    expect(html).not.toContain("detail-section-count");
  });

  it("does not build the body at all while collapsed", () => {
    const children = jest.fn(() => <p>section body</p>);
    const html = renderToStaticMarkup(<Section {...props({ open: false, children })} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("section body");
    expect(children).not.toHaveBeenCalled();
  });

  it("calls onToggle when the heading button is clicked", () => {
    const onToggle = jest.fn();
    const el = Section(props({ onToggle })) as React.ReactElement;
    const heading = (el.props as { children: React.ReactElement[] }).children[0];
    const button = (heading.props as { children: React.ReactElement }).children;
    (button.props as { onClick: () => void }).onClick();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("adds an extra class for section-specific styling", () => {
    const html = renderToStaticMarkup(<Section {...props({ className: "drift-section" })} />);
    expect(html).toContain('<section class="detail-section drift-section">');
  });

  it("HTML-escapes content rendered in the body as text", () => {
    const html = renderToStaticMarkup(<Section {...props({ children: () => "<img src=x onerror=alert(1)>" })} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
