import { describe, it } from 'mocha';
import assert = require('assert');
import { createHttpsClient } from '../src/http';

// Confirms createHttpsClient's ONLY validation gate on the destination is the
// https:// scheme check -- there is no destination-host allowlist/denylist on
// this sink. https-client.ts is byte-identical across TerraformModulePublishV1
// (this registry-publish Bearer/API-key sink) and TerraformDriftReportV1 (the
// TSM-callback token sink), gated by scripts/check-shared-modules.js -- but that
// gate only diffs src/, never Tests/, so TerraformDriftReportV1's
// HttpsClientHostHandlingByDesignL0.ts had no counterpart here until #785. This
// pins the *design* (accept any https host) so a future change that silently
// narrows or widens it shows up in a diff in BOTH tasks that share the sink, not
// only one.
describe('module-publish https-client: destination-host handling (by design, no restriction)', () => {
  it('rejects a non-https URL before any network attempt, regardless of host', async () => {
    const client = createHttpsClient(true, 2000);
    await assert.rejects(
      () => client('POST', 'http://registry.example.com/v1/modules', { Authorization: 'Bearer k' }, '{}'),
      /non-HTTPS/,
    );
  });

  it('does not reject an unusual/unexpected https host at a scheme-check layer (no host allowlist exists)', async () => {
    // A .invalid TLD (RFC 6761) is guaranteed to never resolve, so the request
    // fails at the network/DNS layer, never at a host-validation layer --
    // proving no such layer exists for this sink.
    const client = createHttpsClient(true, 2000);
    await assert.rejects(
      () => client('POST', 'https://internal-registry.invalid/v1/modules', { Authorization: 'Bearer k' }, '{}'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          !/non-HTTPS/.test(err.message),
          'an https:// URL to any host must not be rejected as a scheme violation',
        );
        return true;
      },
    );
  });
});
