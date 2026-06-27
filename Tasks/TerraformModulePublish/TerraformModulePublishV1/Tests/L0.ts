import { describe, it } from 'mocha';
import assert = require('assert');
import { HttpClient, HttpResponse, createHttpsClient, truncateBody } from '../src/http';
import * as priv from '../src/private-publisher';
import * as hcp from '../src/hcp-publisher';

const noop = (): void => {
    /* suppress log output during tests */
};

interface Call {
    method: string;
    url: string;
    body?: string;
}

/** Builds a fake HttpClient that returns the given responses in order (repeating the last). */
function fakeClient(responses: HttpResponse[]): { client: HttpClient; calls: Call[] } {
    const calls: Call[] = [];
    let i = 0;
    const client: HttpClient = (method, url, _headers, body) => {
        calls.push({ method, url, body });
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return Promise.resolve(response);
    };
    return { client, calls };
}

describe('http client transport', () => {
    it('refuses to send credentials over a non-HTTPS URL', async () => {
        const client = createHttpsClient(true);
        await assert.rejects(
            client('GET', 'http://insecure.example.com/api', { Authorization: 'Bearer k' }),
            /non-HTTPS/,
        );
    });

    it('truncates a long response body and passes a short one through', () => {
        assert.strictEqual(truncateBody(''), '');
        assert.strictEqual(truncateBody('short body'), 'short body');
        const long = 'x'.repeat(600);
        const out = truncateBody(long);
        assert.ok(out.length < long.length, 'long body should be truncated');
        assert.ok(out.endsWith('… (truncated)'), 'should mark truncation');
    });
});

describe('private-publisher', () => {
    describe('url builders', () => {
        it('builds the module url', () => {
            assert.strictEqual(
                priv.moduleUrl('https://r.example.com', { namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0' }),
                'https://r.example.com/api/v1/modules/aceo/networking-vpc/aws',
            );
        });

        it('strips trailing slashes from the base url', () => {
            assert.strictEqual(
                priv.moduleUrl('https://r.example.com///', { namespace: 'a', name: 'b', provider: 'aws', version: '1.0.0' }),
                'https://r.example.com/api/v1/modules/a/b/aws',
            );
        });

        it('builds the sync url', () => {
            assert.strictEqual(
                priv.syncUrl('https://r.example.com', 'abc-123'),
                'https://r.example.com/api/v1/admin/modules/abc-123/scm/sync',
            );
        });
    });

    describe('hasVersion', () => {
        it('detects a present version', () => {
            assert.strictEqual(priv.hasVersion('{"versions":[{"version":"1.0.0"},{"version":"1.1.0"}]}', '1.1.0'), true);
        });
        it('returns false when absent or empty', () => {
            assert.strictEqual(priv.hasVersion('{"versions":[]}', '1.0.0'), false);
            assert.strictEqual(priv.hasVersion('{}', '1.0.0'), false);
        });
    });

    describe('publish', () => {
        const opts = {
            namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0',
            registryUrl: 'https://r.example.com', apiKey: 'k', waitForPublish: false, timeoutSeconds: 5,
        };

        it('resolves the module id and triggers a sync', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"id":"mod-1","versions":[]}' },
                { status: 202, body: '' },
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, opts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[1].method, 'POST');
            assert.strictEqual(calls[1].url, 'https://r.example.com/api/v1/admin/modules/mod-1/scm/sync');
        });

        it('throws when the module is not found', async () => {
            const { client } = fakeClient([{ status: 404, body: '{"error":"not found"}' }]);
            await assert.rejects(() => new priv.PrivateRegistryPublisher(client, opts, noop).publish(), /not found in the registry/);
        });

        it('throws when sync is rejected', async () => {
            const { client } = fakeClient([
                { status: 200, body: '{"id":"mod-1"}' },
                { status: 403, body: '{"error":"nope"}' },
            ]);
            await assert.rejects(() => new priv.PrivateRegistryPublisher(client, opts, noop).publish(), /Failed to trigger sync/);
        });

        it('waits for the version to appear when waitForPublish is set', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"id":"mod-1","versions":[]}' },
                { status: 202, body: '' },
                { status: 200, body: '{"id":"mod-1","versions":[{"version":"1.0.0"}]}' },
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, { ...opts, waitForPublish: true }, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 3);
            assert.match(result.message, /available/);
        });
    });
});

describe('hcp-publisher', () => {
    const base: hcp.HcpOptions = {
        namespace: 'acme', name: 'vpc', provider: 'aws', version: '1.0.0',
        address: 'https://app.terraform.io', token: 't',
        vcsRepoIdentifier: '', vcsBranch: 'main', vcsOauthTokenId: '', commitSha: 'sha',
        waitForPublish: false, timeoutSeconds: 5,
    };

    describe('url + body builders', () => {
        it('builds the module and versions urls', () => {
            assert.strictEqual(
                hcp.moduleUrl(base),
                'https://app.terraform.io/api/v2/organizations/acme/registry-modules/private/acme/vpc/aws',
            );
            assert.strictEqual(hcp.versionsUrl(base), `${hcp.moduleUrl(base)}/versions`);
            assert.strictEqual(hcp.vcsUrl('https://app.terraform.io', 'acme'), 'https://app.terraform.io/api/v2/organizations/acme/registry-modules/vcs');
        });

        it('reads a version status', () => {
            const body = '{"data":{"attributes":{"version-statuses":[{"version":"1.0.0","status":"ok"}]}}}';
            assert.strictEqual(hcp.versionStatus(body, '1.0.0'), 'ok');
            assert.strictEqual(hcp.versionStatus(body, '9.9.9'), undefined);
            assert.strictEqual(hcp.versionStatus('{}', '1.0.0'), undefined);
        });

        it('builds the version create body', () => {
            assert.strictEqual(
                hcp.versionBody('1.2.3', 'deadbeef'),
                '{"data":{"type":"registry-modules-versions","attributes":{"version":"1.2.3","commit-sha":"deadbeef"}}}',
            );
        });
    });

    describe('publish', () => {
        it('skips when the version is already ok', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"data":{"attributes":{"version-statuses":[{"version":"1.0.0","status":"ok"}]}}}' },
            ]);
            const result = await new hcp.HcpPublisher(client, base, noop).publish();
            assert.strictEqual(result.published, false);
            assert.strictEqual(calls.length, 1);
        });

        it('creates a version when the module exists but the version does not', async () => {
            const { client, calls } = fakeClient([
                { status: 200, body: '{"data":{"attributes":{"version-statuses":[]}}}' },
                { status: 201, body: '{}' },
            ]);
            const result = await new hcp.HcpPublisher(client, base, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[1].url, hcp.versionsUrl(base));
        });

        it('creates the VCS module then the version on 404', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{}' },
                { status: 201, body: '{}' },
                { status: 201, body: '{}' },
            ]);
            const opts = { ...base, vcsRepoIdentifier: 'acme/proj/_git/terraform-aws-vpc', vcsOauthTokenId: 'ot-abc' };
            const result = await new hcp.HcpPublisher(client, opts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 3);
            assert.strictEqual(calls[1].url, hcp.vcsUrl(base.address, base.namespace));
        });

        it('throws on 404 when VCS details are missing', async () => {
            const { client } = fakeClient([{ status: 404, body: '{}' }]);
            await assert.rejects(() => new hcp.HcpPublisher(client, base, noop).publish(), /vcsRepoIdentifier/);
        });

        it('treats a 422 version response as already-exists', async () => {
            const { client } = fakeClient([
                { status: 200, body: '{"data":{"attributes":{"version-statuses":[]}}}' },
                { status: 422, body: '{}' },
            ]);
            const result = await new hcp.HcpPublisher(client, base, noop).publish();
            assert.strictEqual(result.published, true);
        });
    });
});
