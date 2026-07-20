import { describe, it } from 'mocha';
import assert = require('assert');
import { retryAsync, parseRetryAfterMs } from '../src/retry';

/**
 * Direct unit tests for the shared retry.ts module itself -- retryAsync
 * (bounded exponential-backoff retry) and parseRetryAfterMs (the capped HTTP
 * 429 Retry-After parser). retry.ts is duplicated byte-identically across
 * seven tasks (TerraformTaskV5, TerraformModulePublishV1,
 * TerraformDriftReportV1, PublishKbArticleV1, TerraformInstallerV1,
 * PolicyAgentInstallerV1, TerraformDocsInstallerV1; see
 * scripts/check-shared-modules.js), and before this file existed it was
 * exercised only indirectly through each task's own consumer
 * (id-token-generator.ts / http.ts / callback.ts / servicenow-http.ts /
 * http-client.ts) -- the #497 pattern where a shared module has no test of
 * its own, so a defect in the module itself could hide behind every
 * consumer's mocked/stubbed transport. These call the real exports directly
 * with small real delays -- no fake/mocked timers.
 */
describe('retry.ts: retryAsync (shared bounded-backoff retry)', () => {
    it('succeeds after transient failures are retried', async () => {
        let calls = 0;
        const result = await retryAsync(() => {
            calls += 1;
            return calls < 3 ? Promise.reject(new Error(`transient-${calls}`)) : Promise.resolve('ok');
        }, { retries: 3, baseDelayMs: 2 });
        assert.strictEqual(result, 'ok');
        assert.strictEqual(calls, 3, 'should have retried twice before succeeding on the third attempt');
    });

    it('throws a non-retryable error immediately without further attempts', async () => {
        let calls = 0;
        await assert.rejects(
            retryAsync(() => {
                calls += 1;
                return Promise.reject(new Error('deterministic'));
            }, { retries: 3, baseDelayMs: 2, retryError: () => false }),
            /deterministic/,
        );
        assert.strictEqual(calls, 1, 'a non-retryable error must not be retried');
    });

    it('honors the attempt cap and rethrows the last error once exhausted', async () => {
        let calls = 0;
        await assert.rejects(
            retryAsync(() => {
                calls += 1;
                return Promise.reject(new Error(`fail-${calls}`));
            }, { retries: 2, baseDelayMs: 2 }),
            /fail-3/,
        );
        assert.strictEqual(calls, 3, 'total attempts = retries + 1 (initial attempt + 2 retries)');
    });

    it('applies decorrelated jitter to the default backoff, seeded from an injectable random source (#692)', async () => {
        const seen: number[] = [];
        let calls = 0;
        const randomValues = [0, 1, 0.5];
        let i = 0;
        await retryAsync(() => {
            calls += 1;
            return calls < 4 ? Promise.reject(new Error('e')) : Promise.resolve('done');
        }, {
            retries: 3,
            baseDelayMs: 5,
            random: () => randomValues[i++],
            onRetry: (_attempt, delayMs) => seen.push(delayMs),
        });
        // Decorrelated jitter: delay = baseDelayMs + random() * (max(baseDelayMs, previousDelay*3) - baseDelayMs),
        // with previousDelay seeded at baseDelayMs and updated to the delay just computed.
        //   attempt 0: bound [5,15],  random()=0   -> 5
        //   attempt 1: bound [5,15],  random()=1   -> 15
        //   attempt 2: bound [5,45],  random()=0.5 -> 25
        assert.deepStrictEqual(seen, [5, 15, 25], 'should follow the documented decorrelated-jitter recurrence exactly');
    });

    it('keeps the default (non-injected) jittered delay within [baseDelayMs, maxBackoffMs] on every attempt', async () => {
        const seen: number[] = [];
        let calls = 0;
        await retryAsync(() => {
            calls += 1;
            return calls < 4 ? Promise.reject(new Error('e')) : Promise.resolve('done');
        }, {
            retries: 3,
            baseDelayMs: 5,
            maxBackoffMs: 1000,
            onRetry: (_attempt, delayMs) => seen.push(delayMs),
        });
        assert.strictEqual(seen.length, 3);
        for (const delay of seen) {
            assert.ok(delay >= 5 && delay <= 1000, `expected each jittered delay within [5,1000], got ${delay}`);
        }
    });

    it('gives up immediately once the maxElapsedMs wall-clock budget is exhausted, even with retries remaining (#692)', async () => {
        let calls = 0;
        await assert.rejects(
            retryAsync(() => {
                calls += 1;
                return Promise.reject(new Error(`fail-${calls}`));
            }, { retries: 10, baseDelayMs: 50, maxElapsedMs: 0 }),
            /fail-1/,
        );
        assert.strictEqual(calls, 1, 'a zero-length budget must stop after the very first attempt');
    });
});

describe('retry.ts: parseRetryAfterMs (429 Retry-After parsing)', () => {
    it('parses an integer-seconds Retry-After into milliseconds', () => {
        assert.strictEqual(parseRetryAfterMs('5'), 5000);
        assert.strictEqual(parseRetryAfterMs('0'), 0);
    });

    it('treats invalid/junk input as absent (falls back to backoff)', () => {
        assert.strictEqual(parseRetryAfterMs(null), undefined);
        assert.strictEqual(parseRetryAfterMs(undefined), undefined);
        assert.strictEqual(parseRetryAfterMs('   '), undefined);
        assert.strictEqual(parseRetryAfterMs('not-a-number'), undefined);
    });

    it('clamps an excessive Retry-After to the cap', () => {
        assert.strictEqual(parseRetryAfterMs('99999'), 30000);
        assert.strictEqual(parseRetryAfterMs('50', 10_000), 10_000);
    });
});
