import * as caps from "./caps";

// Freeze test for the single-source-of-truth size caps. WP-0 owns the frozen
// contract; this locks the §6 numbers so a change to a limit is a visible,
// intentional edit here (and, via scripts/check-shared-modules.js, is forced to
// stay byte-identical with the task-side copy). It also gives the otherwise
// data-only caps.ts full coverage so it does not dilute the tab jest gate.
describe("digest caps (frozen §6 contract)", () => {
  it("matches the design §6 single-source-of-truth values", () => {
    expect(caps.MAX_RESOURCES).toBe(2000);
    expect(caps.MAX_ATTR_CHANGES_PER_RESOURCE).toBe(200);
    expect(caps.MAX_REDACTED_VALUE_BYTES).toBe(4 * 1024);
    expect(caps.MAX_DIAGNOSTICS).toBe(500);
    expect(caps.MAX_OUTPUTS).toBe(1000);
    expect(caps.MAX_DRIFT).toBe(2000);
    expect(caps.MAX_NOTES).toBe(1000);
    expect(caps.SOFT_MAX_DIGEST_BYTES).toBe(5 * 1024 * 1024);
    expect(caps.HARD_MAX_DIGEST_BYTES).toBe(12 * 1024 * 1024);
    expect(caps.TAB_PARSE_CEILING_BYTES).toBe(16 * 1024 * 1024);
    expect(caps.TAB_MAX_RENDERED_ROWS).toBe(2000);
  });

  it("keeps the size ceilings strictly ordered: soft < hard < parse", () => {
    expect(caps.SOFT_MAX_DIGEST_BYTES).toBeLessThan(caps.HARD_MAX_DIGEST_BYTES);
    expect(caps.HARD_MAX_DIGEST_BYTES).toBeLessThan(caps.TAB_PARSE_CEILING_BYTES);
  });
});
