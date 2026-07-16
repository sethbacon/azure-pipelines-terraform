import * as assert from 'assert';
import { maskHasSensitiveLeaf } from '../src/base-terraform-command-handler';
import { maskHasSensitiveLeaf as redactMaskHasSensitiveLeaf } from '../src/results/redact';

/**
 * Direct unit tests for maskHasSensitiveLeaf (design §5.2.7): the shared
 * "mask === true at any depth" predicate warnIfSensitiveOutputs uses so its
 * detection can't drift from the WP-1 redaction core's own sensitivity rule.
 * The nested-mask cases below are exactly what the PREVIOUS one-level-only
 * `Object.values(mask).some(v => v === true)` scan would have missed.
 */
describe('maskHasSensitiveLeaf', () => {
    it('is the SAME function the redaction core exports (one implementation, §5.2.7 anti-drift)', () => {
        // Not a copy: the handler re-exports redact.ts's predicate, so detection
        // and redaction cannot drift. A future refactor that re-forks a local copy
        // fails here.
        assert.strictEqual(maskHasSensitiveLeaf, redactMaskHasSensitiveLeaf, 'handler must re-export redact.ts maskHasSensitiveLeaf, not define its own');
    });

    it('detects a top-level true', () => {
        assert.strictEqual(maskHasSensitiveLeaf(true), true);
    });

    it('returns false for a top-level false / undefined / null', () => {
        assert.strictEqual(maskHasSensitiveLeaf(false), false);
        assert.strictEqual(maskHasSensitiveLeaf(undefined), false);
        assert.strictEqual(maskHasSensitiveLeaf(null), false);
    });

    it('detects a true at the first level of an object mask', () => {
        assert.strictEqual(maskHasSensitiveLeaf({ password: true }), true);
    });

    it('returns false for an object mask with no true leaf', () => {
        assert.strictEqual(maskHasSensitiveLeaf({ name: false, tags: {} }), false);
    });

    it('detects a true nested two levels deep in an object mask -- the previous one-level scan would have missed this', () => {
        assert.strictEqual(maskHasSensitiveLeaf({ connection: { credentials: { password: true } } }), true);
    });

    it('detects a true nested inside an array mask', () => {
        assert.strictEqual(maskHasSensitiveLeaf({ items: [false, { secret: true }] }), true);
    });

    it('returns false for an empty object or array mask', () => {
        assert.strictEqual(maskHasSensitiveLeaf({}), false);
        assert.strictEqual(maskHasSensitiveLeaf([]), false);
    });
});
