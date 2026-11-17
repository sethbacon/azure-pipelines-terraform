/**
 * Structured Terraform Policy results.
 *
 * With `-json`, Terraform reports policy evaluation as three kinds of event,
 * each carrying `"@policy":"true"`:
 *
 *   policy_result      one per policy evaluated against one object:
 *                      `result`, `target_address`, `policy_address`, `policy_metadata`
 *   policy_diagnostic  an error or warning: `policy_diagnostic` {severity, summary,
 *                      detail}, and -- unless it is an engine setup failure --
 *                      `target_address` and `policy_metadata`
 *   policy_info        an enforce block's message: `policy_info.message`
 *
 * PROVENANCE: these shapes are read from Terraform v1.17.2's source
 * (internal/command/views/json_view.go, views/json/policy.go). Only the setup
 * failure diagnostic has been observed from a real run; a successful evaluation
 * needs an HCP Terraform organization entitled to policy enforcement. Every field
 * is therefore read defensively, and an event this module does not understand is
 * dropped rather than guessed at.
 *
 * Pure: no task-lib, no I/O. policy-enforcement.ts collects the events and the
 * command handler publishes what this module renders.
 */

export type PolicyOutcome = 'passed' | 'failed' | 'unknown';

/** One `@policy` event, reduced to the fields this task uses. */
export interface PolicyEvent {
    type: 'policy_result' | 'policy_diagnostic' | 'policy_info';
    /** Terraform's EvaluateResult name: AllowResult, DenyResult, UnknownResult, PolicyErrorResult, SetupErrorResult, InvalidResult. */
    result?: string;
    /** Address of the resource, provider or module the policy was evaluated against. */
    target?: string;
    /** Address of the policy block, e.g. `resource_policy.aws_s3_bucket.encrypted`. */
    policy?: string;
    policySet?: string;
    enforcementLevel?: string;
    /** Diagnostics only. */
    severity?: string;
    /** A diagnostic's `summary: detail`, or an enforce block's message. */
    text?: string;
}

/** One row of the published report: a policy evaluated against an object. */
export interface PolicyCase {
    name: string;
    suite: string;
    outcome: PolicyOutcome;
    enforcementLevel?: string;
    messages: string[];
}

export interface PolicySummary {
    passed: number;
    failed: number;
    unknown: number;
}

const DEFAULT_SUITE = 'Terraform Policy';
const SETUP_CASE = 'Policy engine setup';

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Parses one stdout line into a policy event, or undefined when it is not one. */
export function parsePolicyEvent(line: string): PolicyEvent | undefined {
    // Cheap rejection first: every other line of a long apply would otherwise be parsed twice.
    if (!line.includes('"@policy"')) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return undefined;
    }
    const event = obj(parsed);
    const type = event.type;
    if (type !== 'policy_result' && type !== 'policy_diagnostic' && type !== 'policy_info') return undefined;

    const metadata = obj(event.policy_metadata);
    const result: PolicyEvent = {
        type,
        result: str(event.result),
        target: str(event.target_address),
        policy: str(event.policy_address) ?? str(metadata.policy_name),
        policySet: str(metadata.policy_set_name),
        enforcementLevel: str(metadata.enforcement_level),
    };
    if (type === 'policy_diagnostic') {
        const diagnostic = obj(event.policy_diagnostic);
        result.severity = str(diagnostic.severity);
        result.text = [str(diagnostic.summary), str(diagnostic.detail)].filter(Boolean).join(': ') || undefined;
    } else if (type === 'policy_info') {
        result.text = str(obj(event.policy_info).message);
    }
    return result;
}

function outcomeOf(result: string | undefined): PolicyOutcome {
    switch (result) {
        case 'AllowResult': return 'passed';
        case 'UnknownResult': return 'unknown';
        // DenyResult, PolicyErrorResult, SetupErrorResult, InvalidResult -- and any
        // name a later Terraform adds: an outcome this task cannot read is not a pass.
        default: return 'failed';
    }
}

/**
 * Folds the events of one run into one case per (policy, object). A diagnostic
 * or message joins the case it names; an error with no result event of its own
 * -- an engine setup failure, above all -- becomes a failed case, so a run that
 * evaluated nothing can never render as an empty, passing report.
 */
export function buildPolicyCases(events: readonly PolicyEvent[]): PolicyCase[] {
    const cases = new Map<string, PolicyCase>();
    const caseFor = (event: PolicyEvent, outcome: PolicyOutcome): PolicyCase => {
        const name = event.policy
            ? (event.target ? `${event.policy} on ${event.target}` : event.policy)
            : (event.target ? `${SETUP_CASE} (${event.target})` : SETUP_CASE);
        let existing = cases.get(name);
        if (!existing) {
            existing = { name, suite: event.policySet ?? DEFAULT_SUITE, outcome, enforcementLevel: event.enforcementLevel, messages: [] };
            cases.set(name, existing);
        }
        return existing;
    };

    // A replaced resource is evaluated twice under one address; the row keeps the worse verdict.
    const rank = new Map<PolicyOutcome, number>([['passed', 0], ['unknown', 1], ['failed', 2]]);
    for (const event of events) {
        if (event.type === 'policy_result') {
            const outcome = outcomeOf(event.result);
            const entry = caseFor(event, outcome);
            if (rank.get(outcome)! > rank.get(entry.outcome)!) entry.outcome = outcome;
            entry.enforcementLevel = entry.enforcementLevel ?? event.enforcementLevel;
            entry.suite = event.policySet ?? entry.suite;
        }
    }
    for (const event of events) {
        if (event.type === 'policy_result' || !event.text) continue;
        const isError = event.type === 'policy_diagnostic' && event.severity === 'error';
        if (event.type === 'policy_info' || !isError) {
            // A message or a warning annotates a row that exists; it does not create a verdict.
            const name = event.policy && event.target ? `${event.policy} on ${event.target}` : event.policy;
            const existing = name ? cases.get(name) : undefined;
            if (existing) existing.messages.push(event.text);
            continue;
        }
        const entry = caseFor(event, 'failed');
        entry.messages.push(event.text);
    }
    return [...cases.values()];
}

export function summarizePolicyCases(cases: readonly PolicyCase[]): PolicySummary {
    const count = (outcome: PolicyOutcome): number => cases.filter(c => c.outcome === outcome).length;
    return { passed: count('passed'), failed: count('failed'), unknown: count('unknown') };
}

// XML 1.0 excludes every C0 control character except tab, LF and CR; they cannot
// be escaped, only removed.
const XML_ILLEGAL_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function xmlEscape(value: string): string {
    return value
        .replace(XML_ILLEGAL_CONTROL_CHARS, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Renders the cases as JUnit XML, one test case per policy and object. A failed
 * policy is a `<failure>` whatever its enforcement level -- the level is in the
 * message, because an advisory failure does not fail the Terraform run and a
 * reader of the Tests tab needs to tell the two apart. `unknown` (values not
 * known until apply) is `<skipped>`.
 */
export function renderPolicyJUnit(cases: readonly PolicyCase[], suiteName: string): string {
    const summary = summarizePolicyCases(cases);
    const body = cases.map(c => {
        const open = `    <testcase classname="${xmlEscape(c.suite)}" name="${xmlEscape(c.name)}">`;
        const level = c.enforcementLevel ? `[${c.enforcementLevel}] ` : '';
        const detail = xmlEscape(level + (c.messages.join('\n') || `Policy ${c.outcome}`));
        if (c.outcome === 'failed') {
            return `${open}\n      <failure message="${xmlEscape(level + (c.messages[0] ?? 'Policy failed'))}">${detail}</failure>\n    </testcase>`;
        }
        if (c.outcome === 'unknown') {
            return `${open}\n      <skipped message="${xmlEscape(level + 'Not known until apply')}"/>\n    </testcase>`;
        }
        return c.messages.length ? `${open}\n      <system-out>${detail}</system-out>\n    </testcase>` : `${open}</testcase>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${xmlEscape(suiteName)}" tests="${cases.length}" failures="${summary.failed}" skipped="${summary.unknown}">
${body}
  </testsuite>
</testsuites>
`;
}
