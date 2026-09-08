import { describe, it } from 'mocha';
import assert = require('assert');
import * as path from 'path';
import * as ttm from 'azure-pipelines-task-lib/mock-test';

/**
 * CLASS TEST — #588: an option that disables TLS certificate verification is
 * honoured only against a destination proven private.
 *
 * SCOPE. What a green run here claims for THIS task: `rejectUnauthorized=false`
 * is honoured only when `callbackUrl` is, or resolves to, a private/link-local
 * address; the decision survives every spelling of the same destination (rooted
 * FQDN, mixed case, IP literal, bracketed IPv6); a value that does not parse, or
 * that carries userinfo, is refused rather than let through; and the refusal
 * happens before the transport exists, so the one-shot callback token is never
 * presented to an unverified peer.
 *
 * WHY A TABLE. This task and TerraformModulePublishV1 had two hand-written
 * spellings of one control, and the weaker of the two was bypassed by a rooted
 * FQDN. The rows below are deliberately the SAME table as ModulePublish's, over
 * `callbackUrl` instead of `registryUrl`, because the two inputs are one class:
 * a destination shape that is settled here is settled there.
 *
 * MUTATION. Replacing the `assertTlsOptOutDestinationIsPrivate` call in
 * src/callback.ts with the old ModulePublish denylist (`hostname ===
 * 'terraform.io' || hostname.endsWith('.terraform.io')`) turns the rooted-FQDN,
 * the unrelated-public-host and the public-IP-literal rows red.
 *
 * DNS is stubbed by the fixture (Tests/stub-dns.ts), so a name row asserts the
 * guard rather than the runner's network.
 */

interface DestinationRow {
    readonly label: string;
    readonly callbackUrl: string;
    readonly expect: 'refused' | 'honoured';
    /** The loc key the refusal must carry; defaults to the not-private one. */
    readonly message?: string;
    /** Off means the guard must not fire at all: the class is about the opt-out. */
    readonly rejectUnauthorized?: 'true' | 'false';
}

const NOT_PRIVATE = 'RejectUnauthorizedPublicHostRejected';
const UNUSABLE = 'RejectUnauthorizedUrlUnparseable';

const ROWS: readonly DestinationRow[] = [
    { label: 'rooted public FQDN (the reported bypass shape)', callbackUrl: 'https://app.terraform.io./drift', expect: 'refused' },
    { label: 'rooted public FQDN in upper case', callbackUrl: 'https://APP.TERRAFORM.IO./drift', expect: 'refused' },
    { label: 'public host by name', callbackUrl: 'https://registry.public.example/drift', expect: 'refused' },
    { label: 'public IPv4 literal', callbackUrl: 'https://8.8.8.8/drift', expect: 'refused' },
    { label: 'public IPv6 literal', callbackUrl: 'https://[2001:4860:4860::8888]/drift', expect: 'refused' },
    { label: 'value the URL parser rejects', callbackUrl: 'not-a-valid-url', expect: 'refused', message: UNUSABLE },
    { label: 'destination carrying userinfo', callbackUrl: 'https://svc:s3cr3t@10.0.0.5/drift', expect: 'refused', message: UNUSABLE },
    { label: 'private IPv4 literal', callbackUrl: 'https://10.0.0.5/drift', expect: 'honoured' },
    { label: 'loopback IPv6 literal', callbackUrl: 'https://[::1]/drift', expect: 'honoured' },
    { label: 'name resolving into RFC1918 space', callbackUrl: 'https://tsm.internal/drift', expect: 'honoured' },
    { label: 'ROOTED name resolving into RFC1918 space', callbackUrl: 'https://tsm.internal./drift', expect: 'honoured' },
    { label: 'public destination, switch off', callbackUrl: 'https://registry.public.example/drift', expect: 'honoured', rejectUnauthorized: 'true' },
];

describe('TerraformDriftReport rejectUnauthorized destination class (#588)', function () {
    this.timeout(20000);

    ROWS.forEach((row) => {
        it(`${row.expect === 'refused' ? 'refuses' : 'honours'} rejectUnauthorized=false against a ${row.label}`, async () => {
            process.env['TFDR_CLASS_CALLBACK_URL'] = row.callbackUrl;
            process.env['TFDR_CLASS_REJECT_UNAUTHORIZED'] = row.rejectUnauthorized || 'false';
            const tr = new ttm.MockTestRunner(path.join(__dirname, 'DriftReportTlsOptOutDestinationClass.js'));
            try {
                await tr.runAsync();
                const warned = tr.warningIssues.some((w) => w.includes('RejectUnauthorizedDisabled'));
                if (row.expect === 'refused') {
                    assert.ok(tr.failed, `task should have failed for ${row.callbackUrl}`);
                    assert.ok(
                        tr.stdout.includes(row.message || NOT_PRIVATE),
                        `should fail with ${row.message || NOT_PRIVATE} for ${row.callbackUrl}. stdout: ${tr.stdout}`,
                    );
                    // Refuse BEFORE the warning, never warn-then-proceed.
                    assert.ok(!warned, `must refuse before the rejectUnauthorized warning for ${row.callbackUrl}`);
                    // The token must never reach an unverified peer: the POST is
                    // only reported once a callback actually happened.
                    assert.ok(
                        !tr.stdout.includes('DriftPostedToTsm'),
                        `must refuse before the callback is POSTed for ${row.callbackUrl}. stdout: ${tr.stdout}`,
                    );
                } else {
                    assert.ok(tr.succeeded, `task should have succeeded for ${row.callbackUrl}. stdout: ${tr.stdout}`);
                    assert.strictEqual(
                        warned,
                        (row.rejectUnauthorized || 'false') === 'false',
                        `the RejectUnauthorizedDisabled warning must fire exactly when verification is off (${row.callbackUrl})`,
                    );
                }
            } catch (error) {
                console.log('STDERR', tr.stderr);
                console.log('STDOUT', tr.stdout);
                throw error;
            } finally {
                delete process.env['TFDR_CLASS_CALLBACK_URL'];
                delete process.env['TFDR_CLASS_REJECT_UNAUTHORIZED'];
            }
        });
    });
});
