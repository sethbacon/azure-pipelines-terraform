import { describe, it } from 'mocha';
import assert = require('assert');
import { createHttpsClient } from '../src/https-client';

// Confirms createHttpsClient's ONLY validation gate on the destination is the
// https:// scheme check -- there is no destination-host allowlist/denylist on
// this sink (audit id30/#730). PublishKbArticleV1 has dedicated SSRF-restriction
// tests for its analogous ServiceNow instance sink (InstanceSsrfDotDotReject.ts /
// InstanceSsrfEmbeddedHostReject.ts); this test pins down that the drift-callback
// sink's *design* is instead to accept any https host, so a future change that
// silently narrows or widens this is visible in a diff here instead of only in
// runtime behavior.
describe('drift callback https-client: destination-host handling (by design, no restriction)', () => {
  it('rejects a non-https URL before any network attempt, regardless of host', async () => {
    const client = createHttpsClient(true, 2000);
    await assert.rejects(
      () => client('POST', 'http://tsm.example.com/drift', {}, '{}'),
      /Refusing to send credentials over a non-HTTPS URL/,
    );
  });

  it('does not reject an unusual/unexpected https host at a scheme-check layer (no host allowlist exists)', async () => {
    // A .invalid TLD (RFC 6761) is guaranteed to never resolve, so the request
    // fails at the network/DNS layer, never at a host-validation layer --
    // proving no such layer exists for this sink.
    const client = createHttpsClient(true, 2000);
    await assert.rejects(
      () => client('POST', 'https://internal-service.invalid/drift', {}, '{}'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          !/Refusing to send credentials over a non-HTTPS URL/.test(err.message),
          'an https:// URL to any host must not be rejected as a scheme violation',
        );
        return true;
      },
    );
  });
});
