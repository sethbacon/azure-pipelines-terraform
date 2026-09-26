/**
 * Anti-regression tripwires (design §12.4 / this WP's tripwires 2 and 4).
 * These are permanent, static-analysis guards over the tab source tree — not
 * behavioral unit tests — so a future change that reintroduces an HTML sink
 * or a new network destination fails CI loudly, even if no one writes a
 * behavioral test for the specific new code path.
 */

import * as fs from "fs";
import * as path from "path";

const TAB_SRC_DIR = path.resolve(__dirname);

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__mocks__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(listSourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe("tripwire (2): dangerouslySetInnerHTML is confined to the raw-fallback sink", () => {
  const allowlist = new Set([path.join(TAB_SRC_DIR, "components", "RawView.tsx"), path.join(TAB_SRC_DIR, "ansi-to-html.ts")]);
  // Matches only the actual JSX prop usage (`dangerouslySetInnerHTML={...}`),
  // not doc-comment mentions of the name (this file, and several components,
  // reference the term in prose to explain why they DON'T use it).
  const ACTUAL_USAGE_PATTERN = /dangerouslySetInnerHTML\s*=\s*\{/;

  it("appears (as actual JSX usage) in no other source file under src/tab", () => {
    const offenders = listSourceFiles(TAB_SRC_DIR).filter(
      (file) => !allowlist.has(file) && ACTUAL_USAGE_PATTERN.test(fs.readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("is present as actual JSX usage in RawView.tsx (sanity check: the tripwire is not vacuously passing)", () => {
    const content = fs.readFileSync(path.join(TAB_SRC_DIR, "components", "RawView.tsx"), "utf8");
    expect(content).toMatch(ACTUAL_USAGE_PATTERN);
  });

  it("every allowlisted file still exists (catches a rename that would silently widen the allowlist)", () => {
    for (const file of allowlist) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });
});

describe("tripwire (6): the tab page carries a strict Content-Security-Policy", () => {
  const indexHtml = fs.readFileSync(path.join(TAB_SRC_DIR, "index.html"), "utf8");
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(indexHtml);
  const directives = new Map<string, string[]>(
    (meta?.[1] ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map((parts) => [parts[0].toLowerCase(), parts.slice(1)])
  );

  it("declares the policy in <head>, before the bundle's script tag", () => {
    expect(meta).not.toBeNull();
    expect(indexHtml.indexOf("Content-Security-Policy")).toBeLessThan(indexHtml.indexOf("<script"));
    expect(indexHtml.indexOf("Content-Security-Policy")).toBeLessThan(indexHtml.indexOf("</head>"));
  });

  it("denies by default and runs only same-origin script: no inline script, no eval", () => {
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
  });

  it("blocks plugins, base-URI rewrites and form submission", () => {
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
  });

  it("allows no wildcard source and no data:/blob: connections anywhere", () => {
    for (const [name, sources] of directives) {
      expect({ name, sources: sources.filter((s) => s === "*" || /^\*\./.test(s)) }).toEqual({ name, sources: [] });
    }
    expect(directives.get("connect-src")).toEqual(["https:", "http:"]);
  });

  it("the page loads no inline script", () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });
});

describe("tripwire (4): no new network surface — fetch only ever targets the ADO attachment link", () => {
  it("tabContent.tsx has exactly the two known fetch() call sites, both using attachment._links.self.href", () => {
    const content = fs.readFileSync(path.join(TAB_SRC_DIR, "tabContent.tsx"), "utf8");
    const fetchCalls = content.match(/\bfetch\(/g) ?? [];
    const adoAttachmentFetchCalls = content.match(/fetch\(attachment\._links\.self\.href/g) ?? [];
    expect(fetchCalls.length).toBe(adoAttachmentFetchCalls.length);
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("no fetch() call anywhere under src/tab uses a literal http(s) URL (only the ADO-provided attachment href)", () => {
    for (const file of listSourceFiles(TAB_SRC_DIR)) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/fetch\(\s*["'`]https?:\/\//);
    }
  });

  it("no source file under src/tab references a CDN, telemetry, analytics, or font host", () => {
    const suspiciousHostPattern = /(cdn\.|googleapis\.com|fonts\.(googleapis|gstatic)|google-analytics|segment\.io|sentry\.io|doubleclick|mixpanel)/i;
    for (const file of listSourceFiles(TAB_SRC_DIR)) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(suspiciousHostPattern);
    }
  });

  it("no source file other than tabContent.tsx performs its own network call (fetch/XMLHttpRequest/WebSocket)", () => {
    for (const file of listSourceFiles(TAB_SRC_DIR)) {
      if (file === path.join(TAB_SRC_DIR, "tabContent.tsx")) continue;
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/\bfetch\(/);
      expect(content).not.toMatch(/XMLHttpRequest/);
      expect(content).not.toMatch(/new WebSocket/);
    }
  });
});
