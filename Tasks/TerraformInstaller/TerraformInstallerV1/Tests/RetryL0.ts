import { describe, it } from 'mocha';
import assert = require('assert');
import { retryAsync, parseRetryAfterMs } from '../src/retry';

/**
 * Direct unit tests for the shared retry.ts module itself -- retryAsync
 * (bounded exponential-backoff retry) and parseRetryAfterMs (the capped HTTP
 * 429 Retry-After parser). retry.ts is duplicated byte-identically across
 * seven tasks (TerraformTaskV5, TerraformModulePublishV1,
 * TerraformDriftReportV1, PublishKbArticleV1, and the three installer tasks
 * TerraformInstallerV1 / PolicyAgentInstallerV1 / TerraformDocsInstallerV1; see
 * scripts/check-shared-modules.js), and before this file existed it was
 * exercised only indirectly through each task's own consumer
 * (id-token-generator.ts / http.ts / callback.ts / servicenow-http.ts /
 * http-client.ts) -- the #497 pattern where a shared module has no test of its
 * own, so a defect in the module itself could hide behind every consumer's
 * mocked/stubbed transport. These call the real exports directly with small
 * real delays -- no fake/mocked timers. This installer copy (#645) is required
 * because the installer http-client.ts's withRetry now delegates to retry.ts,
 * so this task's own CI job must independently exercise the shared loop.
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

    it('grows the default exponential backoff across attempts', async () => {
        const seen: number[] = [];
        let calls = 0;
        await retryAsync(() => {
            calls += 1;
            return calls < 4 ? Promise.reject(new Error('e')) : Promise.resolve('done');
        }, {
            retries: 3,
            baseDelayMs: 5,
            onRetry: (_attempt, delayMs) => seen.push(delayMs),
        });
        // baseDelayMs * 2**attempt for attempts 0, 1, 2 -- 5, 10, 20.
        assert.deepStrictEqual(seen, [5, 10, 20], 'each retry should wait longer than the last (exponential backoff)');
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
