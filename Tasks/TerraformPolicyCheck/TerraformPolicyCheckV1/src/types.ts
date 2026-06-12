/** Outcome of one policy or deny rule, used for JUnit reporting. */
export interface PolicyCase {
    name: string;
    passed: boolean;
    message?: string;
    enforcementLevel?: string;
}

/** Aggregate result of an engine evaluation. */
export interface PolicyResult {
    /** Overall gating outcome after enforcement levels are applied. */
    passed: boolean;
    /** Human-readable violation messages (deny strings / failed policy names). */
    violations: string[];
    /** Per-policy / per-rule breakdown for JUnit output. */
    cases: PolicyCase[];
    /** Raw engine stdout, persisted to the results file. */
    rawOutput: string;
}
