#!/usr/bin/env node
// Backstops scripts/check-shared-modules.js's FAMILIES allowlist. That script
// enforces byte-identity for REGISTERED duplicated modules, but a NEW
// unregistered cross-task copy (someone copies foo.ts into another task and
// forgets to register it) escapes the gate entirely -- this is exactly how
// #681 happened. This scanner finds any pair of same-basename .ts files
// under two different tasks' src/ trees whose normalized content similarity
// is high enough to be a probable duplicate, and fails if that specific pair
// isn't already registered (as a FAMILIES dir+module pair, or a
// REGION_FAMILIES file pair). It does not replace check-shared-modules.js --
// a flagged pair should be registered there (for real byte-identity
// enforcement), not "fixed" by silencing this scanner.
//
// Dependency-free (Node stdlib only) and read-only.

const fs = require('fs');
const path = require('path');
const { FAMILIES, REGION_FAMILIES } = require('./check-shared-modules.js');

const repoRoot = path.resolve(__dirname, '..');

// Conservative similarity threshold. Every genuine duplicate pair already in
// the tree (the registered FAMILIES) normalizes to a Jaccard similarity of
// 1.0 -- comment/whitespace-only drift never brings two truly-shared files
// below roughly 0.9 in practice. 0.85 leaves headroom above the incidental
// structural similarity between small, unrelated same-named files (two
// different files both happen to be short, both import the same few
// stdlib/task-lib symbols, ...) while still catching a genuine copy-paste
// well before it drifts far enough to look unrelated. Tuned against the
// current tree: at 0.85 this scanner is green (see fix-I.json / #760) with
// every real near-duplicate already covered by a FAMILIES or REGION_FAMILIES
// entry. If a future *unrelated* pair starts tripping it, prefer excluding
// that specific basename/pair over raising the threshold -- raising it would
// blind the gate to real future copy-paste duplicates.
const SIMILARITY_THRESHOLD = 0.85;

const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', 'build', 'coverage']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Strip //-line and /* */-block comments (leaving newlines intact), then
// split into trimmed, whitespace-collapsed, non-empty lines. Formatting-only
// drift (indentation, blank lines, trailing comments) never masks -- or
// inflates -- the similarity score this way.
function normalizedLines(content) {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
  return noLineComments
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

// Jaccard similarity over normalized, non-empty source lines.
function similarity(linesA, linesB) {
  const setA = new Set(linesA);
  const setB = new Set(linesB);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const line of setA) {
    if (setB.has(line)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relFromRoot(full) {
  return toPosix(path.relative(repoRoot, full));
}

// Tiny union-find, scoped to a single basename's coverage graph (see below).
function find(parent, x) {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
}

function union(parent, a, b) {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA !== rootB) parent.set(rootA, rootB);
}

// A pair is already registered if it's transitively covered by FAMILIES for
// the shared basename, or if both files appear together in the same
// REGION_FAMILIES entry's `files` list.
//
// "Transitively covered" matters because a dir can be the byte-identical
// canonical source in more than one FAMILIES entry for the same module (a
// hub) -- e.g. http-client.ts pairs [TerraformInstallerV1, PolicyAgentInstallerV1]
// in one family and [TerraformInstallerV1, TerraformDocsInstallerV1] in
// another. Both non-hub copies are therefore guaranteed byte-identical to
// each other via the shared hub, even though no single family entry lists
// them together directly. Checking only direct per-family membership would
// wrongly flag that already-covered pair. Build a union-find over every dir
// that shares a FAMILIES entry for this basename and test connectivity,
// rather than raising the similarity threshold to hide it.
function isRegistered(fileA, fileB, basename) {
  const dirA = toPosix(path.relative(repoRoot, path.dirname(fileA)));
  const dirB = toPosix(path.relative(repoRoot, path.dirname(fileB)));

  const parent = new Map();
  const ensure = (d) => {
    if (!parent.has(d)) parent.set(d, d);
  };
  for (const family of FAMILIES) {
    if (!family.modules.includes(basename)) continue;
    const dirs = family.dirs.map((d) => d.replace(/\/$/, ''));
    dirs.forEach(ensure);
    for (let k = 1; k < dirs.length; k++) union(parent, dirs[0], dirs[k]);
  }
  if (parent.has(dirA) && parent.has(dirB) && find(parent, dirA) === find(parent, dirB)) {
    return true;
  }

  const relA = relFromRoot(fileA);
  const relB = relFromRoot(fileB);
  for (const region of REGION_FAMILIES) {
    if (region.files.includes(relA) && region.files.includes(relB)) return true;
  }
  return false;
}

function collectSrcRoots() {
  const tasksDir = path.join(repoRoot, 'Tasks');
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((family) => {
      const familyDir = path.join(tasksDir, family.name);
      return fs
        .readdirSync(familyDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((version) => path.join(familyDir, version.name, 'src'));
    })
    .filter((dir) => fs.existsSync(dir));
}

function main() {
  const srcRoots = collectSrcRoots();
  const files = srcRoots
    .flatMap((root) => walk(root, []))
    // Exclude each task's own entrypoint: a top-level src/index.ts
    // legitimately recurs by name across every task without being a
    // duplicated-logic risk.
    .filter((file) => !(path.basename(file) === 'index.ts' && srcRoots.includes(path.dirname(file))));

  const byBasename = new Map();
  for (const file of files) {
    const basename = path.basename(file);
    if (!byBasename.has(basename)) byBasename.set(basename, []);
    byBasename.get(basename).push(file);
  }

  const contentCache = new Map();
  function linesFor(file) {
    if (!contentCache.has(file)) {
      const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      contentCache.set(file, normalizedLines(raw));
    }
    return contentCache.get(file);
  }

  let hasUnregistered = false;

  for (const [basename, group] of byBasename) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const fileA = group[i];
        const fileB = group[j];
        const score = similarity(linesFor(fileA), linesFor(fileB));
        if (score < SIMILARITY_THRESHOLD) continue;
        if (isRegistered(fileA, fileB, basename)) continue;
        hasUnregistered = true;
        console.error(
          `FAIL: unregistered near-duplicate '${basename}' (similarity ${score.toFixed(3)}):\n` +
          `      ${relFromRoot(fileA)}\n` +
          `      ${relFromRoot(fileB)}\n` +
          '      -> register this pair in scripts/check-shared-modules.js FAMILIES, or de-duplicate.',
        );
      }
    }
  }

  if (hasUnregistered) {
    process.exit(1);
  }
  console.log('No unregistered near-duplicate modules found.');
}

if (require.main === module) {
  main();
}

module.exports = { main, similarity, normalizedLines, SIMILARITY_THRESHOLD };
