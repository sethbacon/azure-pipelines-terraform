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

  it('#1114: does not reject a callbackUrl resolving to a private/link-local address (e.g. the cloud metadata service) on the DEFAULT (TLS-verified) path', async () => {
    // assertRejectUnauthorizedNotAgainstPublicHost (callback.ts) only runs
    // when rejectUnauthorized=false -- it exists to stop TLS verification
    // being disabled against a genuinely PUBLIC host, not to restrict which
    // hosts the DEFAULT (rejectUnauthorized=true) path may reach. Unlike the
    // TLS-off branch, which DriftReportCallbackTlsOff*.ts thoroughly covers,
    // no equivalently-named test pinned the by-design absence of a general
    // egress allowlist on this default path -- so a future contributor adding
    // one only to the TLS-off branch (inconsistently with the rest of the
    // callback flow) would have had no test signal either way. 169.254.169.254
    // is a real literal address (not a DNS name), so this proves rejection
    // happens only at the transport-attempt layer (refused/timed-out
    // connection), never at a host-validation layer -- this request is
    // CURRENTLY PERMITTED to reach that host by design.
    const client = createHttpsClient(true, 2000);
    await assert.rejects(
      () => client('POST', 'https://169.254.169.254/drift', {}, '{}'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          !/Refusing to send credentials over a non-HTTPS URL/.test(err.message),
          'a private/link-local https:// destination must not be rejected as a scheme violation',
        );
        assert.ok(
          !/not allowed|disallowed|blocked|denylist|allowlist/i.test(err.message),
          `expected a transport-layer failure (refused/timed out), not a host-validation rejection: ${err.message}`,
        );
        return true;
      },
    );
  });
});
