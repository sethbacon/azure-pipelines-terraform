/**
 * Anti-regression tripwire (design docs/initiatives/structured-plan-apply-tabs.md
 * §12.4.5 "scope tripwire"): asserts the extension manifest requests no scope
 * beyond the existing `vso.build` (build-read). The structured plan/apply
 * results feature adds no new pipeline permission/scope (design §1 "Out of
 * scope"; §5.7 "Request only the build-read scope already in use; introduce no
 * new scopes.") — this is a static, permanent guard so a future manifest edit
 * that widens `scopes` fails CI loudly rather than silently shipping a
 * broader-than-documented permission request.
 *
 * Lives under src/tab/ (rather than a new script) so it runs automatically as
 * part of the existing "Build and Test Tab" CI job (`npm run test:tab`) with
 * no workflow changes, following the same pattern as this directory's other
 * design-§12.4 tripwires.
 */

import * as fs from "fs";
import * as path from "path";

describe("tripwire (5): extension manifest requests no scope beyond build-read", () => {
  const manifestPath = path.resolve(__dirname, "..", "..", "azure-devops-extension.json");

  it("azure-devops-extension.json exists at the expected repo-root path", () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it("scopes is exactly ['vso.build'] -- no additional or broader scope", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(Array.isArray(manifest.scopes)).toBe(true);
    expect(manifest.scopes).toEqual(["vso.build"]);
  });
});
