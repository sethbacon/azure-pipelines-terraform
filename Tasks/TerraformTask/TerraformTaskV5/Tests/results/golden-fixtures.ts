import * as fs from 'fs';
import * as path from 'path';
import { buildPlanDigest, DigestMeta } from '../../src/results/plan-digest';
import { buildApplyDigest } from '../../src/results/apply-digest';
import { serializeDigest } from '../../src/results/redact';

// Shared fixture manifest + build helper for the golden regression suite
// (GoldenFixturesL0.ts). Kept free of any mocha global (no describe/it) so a
// one-off generator can `require` it to (re)write the committed goldens.

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// FIXED meta so goldens never churn: never Date.now(), never the real task
// version (§2.6 determinism).
export const PLAN_META: DigestMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-plan',
  workingDirectory: 'infra',
  createdIso: '2026-07-15T00:00:00Z',
};

export const APPLY_META: DigestMeta = {
  taskVersion: '0.0.0-test',
  toolName: 'terraform',
  name: 'terraform-apply',
  workingDirectory: 'infra',
  createdIso: '2026-07-15T00:00:00Z',
};

export interface FixtureSpec {
  /** input file under Tests/fixtures/ */
  input: string;
  /** committed golden under Tests/fixtures/ */
  expected: string;
  kind: 'plan' | 'apply';
  /** fake secret literals that MUST NOT appear in the serialized digest */
  secrets: string[];
}

export const FIXTURES: FixtureSpec[] = [
  { input: 'plan-noop.json', expected: 'plan-noop.expected.json', kind: 'plan', secrets: [] },
  { input: 'plan-create.json', expected: 'plan-create.expected.json', kind: 'plan', secrets: [] },
  { input: 'plan-replace.json', expected: 'plan-replace.expected.json', kind: 'plan', secrets: [] },
  { input: 'plan-destroy.json', expected: 'plan-destroy.expected.json', kind: 'plan', secrets: [] },
  {
    input: 'plan-sensitive.json',
    expected: 'plan-sensitive.expected.json',
    kind: 'plan',
    secrets: ['SUPERSECRET_pw_9f3k', 'TOK_abc123secret', 'PORTSECRET_literal', 'OUTPUTSECRET_xyz'],
  },
  { input: 'plan-multi-provider.json', expected: 'plan-multi-provider.expected.json', kind: 'plan', secrets: [] },
  { input: 'plan-drift.json', expected: 'plan-drift.expected.json', kind: 'plan', secrets: [] },
  { input: 'apply-success.ndjson', expected: 'apply-success.expected.json', kind: 'apply', secrets: [] },
  {
    // Runs with PRODUCTION's empty knownSecrets (the call site passes []), so the
    // golden reflects what actually ships: the diagnostic summary is redacted by
    // the PEM/high-entropy heuristic ALONE (the secret here is a long high-entropy
    // run the heuristic catches), NOT by any setSecret readback. The short-secret
    // residual the heuristic cannot catch is asserted separately in ApplyDigestL0.
    input: 'apply-partial-failure.ndjson',
    expected: 'apply-partial-failure.expected.json',
    kind: 'apply',
    secrets: ['APPLYSECRET_pw_42_FAKEHIGHENTROPY_0123456789abcdef'],
  },
];

/**
 * Build the digest for a fixture and return the canonical serialized form.
 * Apply fixtures are built with `includeDiagnostics: true` EXPLICITLY (empty
 * knownSecrets, includeDiagnosticDetail off) so the diagnostics-render golden
 * coverage is preserved. This intentionally does NOT mirror the production
 * call site's default: the task input `includeDiagnostics` now defaults to
 * `false` (opt-in — see base-terraform-command-handler.ts), but the digest
 * builder itself is exercised here with diagnostics enabled so the
 * diagnostics-bearing fixtures keep asserting real coverage rather than an
 * always-empty array.
 */
export function serializeFixture(spec: FixtureSpec): string {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, spec.input), 'utf8');
  if (spec.kind === 'plan') {
    return serializeDigest(buildPlanDigest(JSON.parse(raw), PLAN_META));
  }
  return serializeDigest(buildApplyDigest(raw, APPLY_META, { includeDiagnostics: true }));
}
