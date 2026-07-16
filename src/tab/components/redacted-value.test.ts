import { formatRedactedValue } from "./redacted-value";

describe("formatRedactedValue", () => {
  it('renders a "value" RedactedValue as its underlying JSON text', () => {
    expect(formatRedactedValue({ kind: "value", json: '"t3.micro"' })).toBe('"t3.micro"');
    expect(formatRedactedValue({ kind: "value", json: "42" })).toBe("42");
  });

  it('renders "sensitive" as (sensitive)', () => {
    expect(formatRedactedValue({ kind: "sensitive" })).toBe("(sensitive)");
  });

  it('renders "unknown" as (known after apply)', () => {
    expect(formatRedactedValue({ kind: "unknown" })).toBe("(known after apply)");
  });

  it('renders "omitted" as (value omitted: too large)', () => {
    expect(formatRedactedValue({ kind: "omitted", reason: "too-large" })).toBe("(value omitted: too large)");
  });
});
