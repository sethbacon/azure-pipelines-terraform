// SHARED MODULE — intentionally duplicated, byte-for-byte, into every task that
// needs bounded exponential-backoff retry. Because each task under Tasks/ is an
// independent npm package that bundles on its own, they cannot cross-import; a
// single shared retry loop is instead kept in sync as identical copies in:
//
//   Tasks/TerraformTask/TerraformTaskV5/src/retry.ts
//   Tasks/TerraformModulePublish/TerraformModulePublishV1/src/retry.ts
//   Tasks/TerraformDriftReport/TerraformDriftReportV1/src/retry.ts
//   Tasks/PublishKbArticle/PublishKbArticleV1/src/retry.ts
//   Tasks/TerraformInstaller/TerraformInstallerV1/src/retry.ts
//   Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/retry.ts
//   Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/retry.ts
//
// CI (scripts/check-shared-modules.js) enforces byte-identity across those
// copies and fails the build on any divergence, so a hardening change
// (decorrelated jitter and the optional max-total-elapsed-time budget, added
// for #692) can never be applied to one copy and silently missed in the
// others. EDIT EVERY COPY TOGETHER.
//
// The retry loops that used to be independently open-coded — the OIDC
// TokenGenerator (id-token-generator.ts), the registry retryHttp (http.ts), the
// drift callback postJsonWithRetry (callback.ts), the ServiceNow withRetry
// (servicenow-http.ts), and the three installer-family fetch clients' withRetry
// (http-client.ts, shared byte-identically across TerraformInstaller /
// PolicyAgentInstaller / TerraformDocsInstaller) — now all delegate here. Each
// keeps its own EXACT semantics by supplying predicates, not by sharing one
// hardcoded policy:
//
//   - retryResult decides whether a RESOLVED value is worth retrying. Default:
//     never. (The drift callback deliberately never retries a received response
//     of any status — its callback token is one-shot; only a pure transport
//     failure, where no response was received, is safe to repeat.)
//   - retryError decides whether a THROWN error is worth retrying. Default:
//     always. (A pure transport failure carries no server-side state.)
//   - delayMs overrides the backoff for a single attempt (e.g. honoring a capped
//     HTTP 429 Retry-After); the default is decorrelated jitter (see retryAsync).
//   - onRetry runs once per retry (never on the final give-up), so each call
//     site keeps its own log wording.
//
// The helper has NO dependency on azure-pipelines-task-lib (all logging is
// delegated through onRetry), which is what lets these copies stay trivially
// identical across tasks with different bundled dependencies.

/** What triggered a retry: a resolved value the caller deemed retryable, or a thrown error. */
export type RetryOutcome<T> =
    | { readonly kind: 'result'; readonly result: T }
    | { readonly kind: 'error'; readonly error: unknown };

export interface RetryController<T> {
    /** Retries AFTER the first attempt (total attempts = retries + 1). Default 3. */
    retries?: number;
    /** Exponential-backoff base in ms; the default jittered delay is never below this. Default 500. */
    baseDelayMs?: number;
    /** Upper bound (ms) on the default jittered delay. Default RETRY_AFTER_CAP_MS (30s). */
    maxBackoffMs?: number;
    /** Entropy source for the default jittered delay, injectable for deterministic tests. Default Math.random. */
    random?: () => number;
    /**
     * Optional wall-clock budget (ms) across ALL attempts of this call; once
     * elapsed, no further retry is scheduled even if attempts/predicates would
     * otherwise allow one -- the last outcome is returned/thrown immediately
     * instead (#692). Default: unbounded (only the `retries` count applies).
     */
    maxElapsedMs?: number;
    /** Whether a resolved value is worth retrying. Default: never. */
    retryResult?: (result: T) => boolean;
    /** Whether a thrown error is worth retrying. Default: always. */
    retryError?: (error: unknown) => boolean;
    /** Override the pre-retry delay for one attempt; the default is decorrelated jitter. */
    delayMs?: (attempt: number, backoffMs: number, outcome: RetryOutcome<T>) => number;
    /** Invoked once before each retry's delay (never on the final give-up). */
    onRetry?: (attempt: number, delayMs: number, outcome: RetryOutcome<T>) => void;
}

/**
 * Run `call` with bounded, jittered-backoff retry. `attempt` is 0-based: the
 * first try is attempt 0, and a retry is scheduled only while attempt < retries
 * AND (when `maxElapsedMs` is set) the elapsed-time budget has not yet run out.
 * A resolved value is returned as soon as retryResult says it is acceptable (or
 * the budget is spent); a thrown error is rethrown as soon as retryError says it
 * is terminal (or the budget is spent).
 *
 * The default per-attempt delay uses decorrelated jitter (AWS's "Exponential
 * Backoff And Jitter"): `delay = min(maxBackoffMs, baseDelayMs + random() *
 * (max(baseDelayMs, previousDelay * 3) - baseDelayMs))`, with `previousDelay`
 * seeded at `baseDelayMs`. Unlike a pure `baseDelayMs * 2**attempt` schedule,
 * this spreads out many concurrent callers retrying the same rate-limited
 * endpoint instead of having them all wait the same deterministic delay in
 * lockstep (#692).
 */
export async function retryAsync<T>(call: () => Promise<T>, controller: RetryController<T> = {}): Promise<T> {
    const retries = controller.retries ?? 3;
    const baseDelayMs = controller.baseDelayMs ?? 500;
    const maxBackoffMs = controller.maxBackoffMs ?? RETRY_AFTER_CAP_MS;
    const random = controller.random ?? Math.random;
    const retryResult = controller.retryResult ?? (() => false);
    const retryError = controller.retryError ?? (() => true);
    const deadline = controller.maxElapsedMs !== undefined ? Date.now() + controller.maxElapsedMs : undefined;
    let previousDelayMs = baseDelayMs;
    for (let attempt = 0; ; attempt++) {
        let outcome: RetryOutcome<T>;
        try {
            const result = await call();
            if (attempt >= retries || (deadline !== undefined && Date.now() >= deadline) || !retryResult(result)) {
                return result;
            }
            outcome = { kind: 'result', result };
        } catch (error) {
            if (attempt >= retries || (deadline !== undefined && Date.now() >= deadline) || !retryError(error)) {
                throw error;
            }
            outcome = { kind: 'error', error };
        }
        const upperBound = Math.max(baseDelayMs, previousDelayMs * 3);
        const backoffMs = Math.min(maxBackoffMs, baseDelayMs + random() * (upperBound - baseDelayMs));
        previousDelayMs = backoffMs;
        const wait = controller.delayMs ? controller.delayMs(attempt, backoffMs, outcome) : backoffMs;
        controller.onRetry?.(attempt, wait, outcome);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
}

/** Upper bound (ms) on an honored HTTP 429 Retry-After, so a hostile/misconfigured server cannot stall the task. */
export const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Parse an HTTP `Retry-After` header into a capped millisecond delay, or
 * undefined when it is absent/blank/invalid (the caller then falls back to its
 * exponential backoff). Accepts both the delta-seconds form (`Retry-After: 120`)
 * and the HTTP-date form (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). A date
 * in the past is treated as invalid (fall back to backoff). The result is
 * clamped to `capMs` so a hostile or misconfigured server cannot stall the task
 * for an arbitrary duration.
 */
export function parseRetryAfterMs(value: string | null | undefined, capMs = RETRY_AFTER_CAP_MS): number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (!Number.isFinite(seconds)) {
            return undefined;
        }
        return Math.min(seconds * 1000, capMs);
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) {
        return undefined;
    }
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, capMs) : undefined;
}
