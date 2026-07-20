import * as fs from 'fs';
import * as path from 'path';
import { buildPlanDigest, DigestBuildMeta } from '../../src/results/plan-digest';
import { buildStateDigest } from '../../src/results/state-digest';
import { serializeDigest } from '../../src/results/redact';

// Phase 5 fixture manifest + build helper for the state-inventory and destroy-
// marker golden regression suite (Phase5GoldenFixturesL0.ts). Kept free of any
// mocha global (no describe/it) so the one-off generator (generate-goldens.ts)
// can `require` it to (re)write the committed goldens. Mirrors the Phase 1-4
// golden-fixtures.ts harness so the two suites read the same way.

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// FIXED meta so goldens never churn: never Date.now(), never the real task
// version (§2.6 determinism).
export const STATE_META: DigestBuildMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-state',
  workingDirectory: 'infra',
  createdIso: '2026-07-15T00:00:00Z',
};

export const PLAN_META: DigestBuildMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-plan',
  workingDirectory: 'infra',
  createdIso: '2026-07-15T00:00:00Z',
};

export interface FixtureSpec {
  /** input file under Tests/fixtures/ */
  input: string;
  /** committed golden under Tests/fixtures/ */
  expected: string;
  /**
   * `state`        -> buildStateDigest (state inventory, §7.2)
   * `plan-destroy` -> buildPlanDigest with {mode:"destroy"} (destroy marker, §7.1)
   */
  kind: 'state' | 'plan-destroy';
  /** fake secret literals that MUST NOT appear in the serialized digest */
  secrets: string[];
}

export const FIXTURES: FixtureSpec[] = [
  { input: 'state-basic.json', expected: 'state-basic.expected.json', kind: 'state', secrets: [] },
  {
    input: 'state-sensitive.json',
    expected: 'state-sensitive.expected.json',
    kind: 'state',
    secrets: ['STATEPW_SUPERSECRET_abc123', 'STATETOKEN_xyz789', 'REPLICASECRET_0', 'REPLICASECRET_1', 'DBCONN_SECRET_literal_9f3k'],
  },
  {
    input: 'state-child-modules.json',
    expected: 'state-child-modules.expected.json',
    kind: 'state',
    secrets: ['MODULESECRET_pw_child'],
  },
  // Destroy marker: the EXISTING plan-destroy.json input built WITH {mode:"destroy"}
  // -> a PlanDigest carrying planMode:"destroy" (§7.1). Proves the caller-supplied
  // marker flows through the unchanged plan builder end-to-end.
  { input: 'plan-destroy.json', expected: 'plan-destroy-marked.expected.json', kind: 'plan-destroy', secrets: [] },
];

/** Build the digest for a fixture and return the canonical serialized form. */
export function serializeFixture(spec: FixtureSpec): string {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, spec.input), 'utf8');
  if (spec.kind === 'state') {
    return serializeDigest(buildStateDigest(JSON.parse(raw), STATE_META));
  }
  return serializeDigest(buildPlanDigest(JSON.parse(raw), PLAN_META, { mode: 'destroy' }));
}
