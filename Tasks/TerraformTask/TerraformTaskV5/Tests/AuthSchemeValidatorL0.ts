import * as assert from 'assert';
import { BaseTerraformCommandHandler } from '../src/base-terraform-command-handler';
import { TerraformCommandHandlerAWS } from '../src/aws-terraform-command-handler';
import { TerraformCommandHandlerGCP } from '../src/gcp-terraform-command-handler';
import { TerraformCommandHandlerOCI } from '../src/oci-terraform-command-handler';

/**
 * Direct unit tests for the hoisted auth-scheme validator (#591): AWS/GCP/OCI
 * previously each carried a byte-identical copy of VALID_AUTH_SCHEMES +
 * validateAuthScheme() (same error message, same behavior), outside the
 * scripts/check-shared-modules.js parity gate — a future scheme addition to
 * one provider's copy could silently diverge from the other two. Both are now
 * a single implementation on BaseTerraformCommandHandler; these tests exercise
 * it through all three provider subclasses to confirm they genuinely share it
 * (not just three copies that still happen to agree).
 */
describe('BaseTerraformCommandHandler.validateAuthScheme (hoisted, #591)', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising a protected member directly
    const handlers: [string, BaseTerraformCommandHandler][] = [
        ['aws', new TerraformCommandHandlerAWS()],
        ['gcp', new TerraformCommandHandlerGCP()],
        ['oci', new TerraformCommandHandlerOCI()],
    ];

    for (const [name, handler] of handlers) {
        it(`${name}: accepts 'ServiceConnection'`, () => {
            assert.doesNotThrow(() => (handler as any).validateAuthScheme('ServiceConnection', 'someInput'));
        });

        it(`${name}: accepts 'WorkloadIdentityFederation'`, () => {
            assert.doesNotThrow(() => (handler as any).validateAuthScheme('WorkloadIdentityFederation', 'someInput'));
        });

        it(`${name}: rejects an unrecognized scheme with the shared error message`, () => {
            assert.throws(
                () => (handler as any).validateAuthScheme('NotARealScheme', 'someInput'),
                /Unrecognized authorization scheme 'NotARealScheme' for input 'someInput'\. Valid values: ServiceConnection, WorkloadIdentityFederation/,
            );
        });
    }

    it('all three provider handlers produce the byte-identical error message (single shared implementation, not three copies)', () => {
        const messages = handlers.map(([, handler]) => {
            try {
                (handler as any).validateAuthScheme('Bogus', 'theInput');
                return undefined;
            } catch (err) {
                return (err as Error).message;
            }
        });
        assert.strictEqual(messages.length, 3);
        assert.ok(messages.every((m) => m === messages[0]), `expected identical messages across providers, got: ${JSON.stringify(messages)}`);
    });

    it('exposes VALID_AUTH_SCHEMES as exactly ServiceConnection and WorkloadIdentityFederation', () => {
        assert.deepStrictEqual(
            (BaseTerraformCommandHandler as any).VALID_AUTH_SCHEMES,
            ['ServiceConnection', 'WorkloadIdentityFederation'],
        );
    });
});
