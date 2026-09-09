import { describe, it } from 'mocha';
import assert = require('assert');
import * as path from 'path';
import * as ttm from 'azure-pipelines-task-lib/mock-test';

/**
 * CLASS TEST — #588: an option that disables TLS certificate verification is
 * honoured only against a destination proven private.
 *
 * SCOPE. What a green run here claims for THIS task: `skipTlsVerify` is
 * honoured only when `registryUrl` is, or resolves to, a private/link-local
 * address; the decision survives every spelling of the same destination (rooted
 * FQDN, mixed case, IP literal, bracketed IPv6); and the refusal happens before
 * the publisher or the HTTPS transport exists, so the apiKey is never presented
 * to an unverified peer. It claims nothing about the case where the switch is
 * off (row: "public destination, switch off"), which must stay unaffected.
 *
 * WHY A TABLE. The reported instance was one destination shape. The guard it
 * replaced was a two-entry `*.terraform.io` denylist that let through the rooted
 * FQDN `https://app.terraform.io./` and every public host that is not
 * terraform.io at all — a per-instance test would have gone on passing for both.
 * The rows below are the CLASS: adding a destination shape adds a row, not a
 * fixture. The sibling table in TerraformDriftReportV1 is deliberately the same
 * table over `callbackUrl`, because the two inputs are one class.
 *
 * MUTATION. Replacing the `assertTlsOptOutDestinationIsPrivate` call in
 * src/index.ts with the old denylist (`hostname === 'terraform.io' ||
 * hostname.endsWith('.terraform.io')`) turns the rooted-FQDN, the
 * unrelated-public-host and the public-IP-literal rows red, and nothing else.
 *
 * DNS is stubbed by the fixture (Tests/stub-dns.ts), so a name row asserts the
 * guard rather than the runner's network.
 */

interface DestinationRow {
    /** Why this destination shape is in the class. */
    readonly label: string;
    readonly registryUrl: string;
    /** 'refused' = the task must fail with the guard's own message and never warn. */
    readonly expect: 'refused' | 'honoured';
    /** Off means the guard must not fire at all: the class is about the opt-out, not about egress. */
    readonly skipTlsVerify?: 'true' | 'false';
}

const ROWS: readonly DestinationRow[] = [
    // The #588 bypass itself: WHATWG URL keeps the trailing dot, so the denylist
    // compared 'app.terraform.io.' against 'terraform.io'/'.terraform.io' and
    // matched neither, while DNS resolves the rooted FQDN to the real registry.
    { label: 'rooted public FQDN (the reported bypass)', registryUrl: 'https://app.terraform.io./v1/modules', expect: 'refused' },
    { label: 'rooted public FQDN in upper case', registryUrl: 'https://APP.TERRAFORM.IO./v1/modules', expect: 'refused' },
    { label: 'public registry by name', registryUrl: 'https://registry.terraform.io/v1/modules', expect: 'refused' },
    { label: 'public registry apex domain', registryUrl: 'https://terraform.io/v1/modules', expect: 'refused' },
    // The half of the class the denylist never covered: any other public host.
    { label: 'unrelated public host', registryUrl: 'https://registry.public.example/v1/modules', expect: 'refused' },
    { label: 'public IPv4 literal', registryUrl: 'https://8.8.8.8/v1/modules', expect: 'refused' },
    { label: 'public IPv6 literal', registryUrl: 'https://[2001:4860:4860::8888]/v1/modules', expect: 'refused' },
    // The legitimate use case must keep working, in each spelling of "private".
    { label: 'private IPv4 literal', registryUrl: 'https://10.0.0.5/v1/modules', expect: 'honoured' },
    { label: 'loopback IPv6 literal', registryUrl: 'https://[::1]/v1/modules', expect: 'honoured' },
    { label: 'name resolving into RFC1918 space', registryUrl: 'https://registry.internal/v1/modules', expect: 'honoured' },
    { label: 'ROOTED name resolving into RFC1918 space', registryUrl: 'https://registry.internal./v1/modules', expect: 'honoured' },
    { label: 'public-looking name that resolves privately', registryUrl: 'https://my-terraform.io.internal.corp/v1/modules', expect: 'honoured' },
    // The guard is scoped to the opt-out: with verification ON, a public
    // registry is an ordinary, correct destination and must not be refused.
    { label: 'public destination, switch off', registryUrl: 'https://registry.terraform.io/v1/modules', expect: 'honoured', skipTlsVerify: 'false' },
];

describe('TerraformModulePublish skipTlsVerify destination class (#588)', function () {
    this.timeout(20000);

    ROWS.forEach((row) => {
        it(`${row.expect === 'refused' ? 'refuses' : 'honours'} skipTlsVerify against a ${row.label}`, async () => {
            process.env['TFMP_CLASS_REGISTRY_URL'] = row.registryUrl;
            process.env['TFMP_CLASS_SKIP_TLS'] = row.skipTlsVerify || 'true';
            const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishSkipTlsVerifyDestinationClass.js'));
            try {
                await tr.runAsync();
                const warned = tr.warningIssues.some((w) => w.includes('SkipTlsVerifyEnabled'));
                if (row.expect === 'refused') {
                    assert.ok(tr.failed, `task should have failed for ${row.registryUrl}`);
                    assert.ok(
                        tr.stdout.includes('SkipTlsVerifyPublicRegistryRejected'),
                        `should fail with the destination-rejection message for ${row.registryUrl}. stdout: ${tr.stdout}`,
                    );
                    // Refuse BEFORE the warning, never warn-then-proceed: the
                    // warning is emitted only on the path that goes on to build
                    // the publisher with verification disabled.
                    assert.ok(!warned, `must refuse before the skipTlsVerify warning for ${row.registryUrl}`);
                } else {
                    assert.ok(tr.succeeded, `task should have succeeded for ${row.registryUrl}. stdout: ${tr.stdout}`);
                    assert.strictEqual(
                        warned,
                        (row.skipTlsVerify || 'true') === 'true',
                        `the SkipTlsVerifyEnabled warning must fire exactly when the switch is on (${row.registryUrl})`,
                    );
                }
            } catch (error) {
                console.log('STDERR', tr.stderr);
                console.log('STDOUT', tr.stdout);
                throw error;
            } finally {
                delete process.env['TFMP_CLASS_REGISTRY_URL'];
                delete process.env['TFMP_CLASS_SKIP_TLS'];
            }
        });
    });
});
