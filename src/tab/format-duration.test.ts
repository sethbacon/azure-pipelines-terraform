import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [640, "640ms"],
    [999.4, "999ms"],
    [999.6, "1.0s"],
    [1000, "1.0s"],
    [1900, "1.9s"],
    [59_940, "59.9s"],
    [59_999, "1m 0s"],
    [89_200, "1m 29s"],
    [734_000, "12m 14s"],
    [3_599_600, "1h 0m"],
    [3_780_000, "1h 3m"],
  ])("formats %p ms as %p", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
