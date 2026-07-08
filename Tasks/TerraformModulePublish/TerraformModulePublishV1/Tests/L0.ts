import { describe, it } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import * as path from 'path';
import * as ttm from 'azure-pipelines-task-lib/mock-test';
import { HttpClient, HttpResponse, createHttpsClient, parseJson, retryHttp, truncateBody } from '../src/http';
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

    it('times out a hung connection instead of hanging', async () => {
        // A bare TCP server that accepts the socket but never completes the TLS
        // handshake — req.setTimeout must fire and reject.
        const server = net.createServer(() => { /* accept and stall */ });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            const client = createHttpsClient(true, 150);
            await assert.rejects(
                client('GET', `https://127.0.0.1:${port}/api`, {}),
                /timed out after 150ms/,
            );
        } finally {
            server.close();
        }
    });

    it('truncates a long response body and passes a short one through', () => {
        assert.strictEqual(truncateBody(''), '');
        assert.strictEqual(truncateBody('short body'), 'short body');
        const long = 'x'.repeat(600);
        const out = truncateBody(long);
        assert.ok(out.length < long.length, 'long body should be truncated');
        assert.ok(out.endsWith('… (truncated)'), 'should mark truncation');
    });

    it('parseJson parses a JSON body but surfaces a non-JSON 2xx body as a truncating error', () => {
        assert.deepStrictEqual(parseJson<{ id: string }>('{"id":"mod-1"}'), { id: 'mod-1' });
        // A captive portal / auth proxy can answer 200 with HTML — must not escape as a raw SyntaxError.
        const html = '<!doctype html><html><body>captive portal login</body></html>';
        assert.throws(
            () => parseJson(html),
            (err: Error) => /non-JSON response body/.test(err.message) && err.message.includes('captive portal'),
        );
    });
});

describe('retryHttp', () => {
    it('returns a 2xx response without retrying', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 200, body: 'ok' }); }, { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls, 1);
    });

    it('does not retry a 4xx response', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 404, body: '' }); }, { baseDelayMs: 0 });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(calls, 1);
    });

    it('retries a 5xx response and returns the eventual success', async () => {
        const responses: HttpResponse[] = [{ status: 503, body: '' }, { status: 200, body: 'ok' }];
        let i = 0;
        const res = await retryHttp(() => Promise.resolve(responses[i++]), { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(i, 2);
    });

    it('retries a thrown transport error and returns the eventual success', async () => {
        let i = 0;
        const res = await retryHttp(() => {
            i += 1;
            return i === 1 ? Promise.reject(new Error('ECONNRESET')) : Promise.resolve({ status: 200, body: 'ok' });
        }, { baseDelayMs: 0 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(i, 2);
    });

    it('returns the last 5xx after exhausting retries', async () => {
        let calls = 0;
        const res = await retryHttp(() => { calls += 1; return Promise.resolve({ status: 500, body: '' }); }, { retries: 2, baseDelayMs: 0 });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(calls, 3); // initial attempt + 2 retries
    });

    it('throws the last error after exhausting retries on a persistent transport failure', async () => {
        let calls = 0;
        await assert.rejects(
            () => retryHttp(() => { calls += 1; return Promise.reject(new Error('ETIMEDOUT')); }, { retries: 2, baseDelayMs: 0 }),
            /ETIMEDOUT/,
        );
        assert.strictEqual(calls, 3);
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

        it('builds the create and link urls', () => {
            assert.strictEqual(
                priv.createUrl('https://r.example.com///'),
                'https://r.example.com/api/v1/admin/modules/create',
            );
            assert.strictEqual(
                priv.linkUrl('https://r.example.com', 'abc-123'),
                'https://r.example.com/api/v1/admin/modules/abc-123/scm',
            );
        });

        it('builds the create and link bodies (system = provider; defaults applied)', () => {
            assert.deepStrictEqual(
                JSON.parse(priv.createBody({ namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0' })),
                { namespace: 'aceo', name: 'networking-vpc', system: 'aws' },
            );
            assert.deepStrictEqual(
                JSON.parse(priv.linkBody({
                    namespace: 'aceo', name: 'networking-vpc', provider: 'aws', version: '1.0.0',
                    registryUrl: 'https://r.example.com', apiKey: 'k', waitForPublish: false, timeoutSeconds: 5,
                    scmProviderId: 'prov-1', repositoryOwner: 'Terraform', repositoryName: 'terraform-aws-networking-vpc',
                })),
                {
                    provider_id: 'prov-1', repository_owner: 'Terraform', repository_name: 'terraform-aws-networking-vpc',
                    default_branch: 'main', tag_pattern: 'v*',
                },
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

        const autoOpts = {
            ...opts,
            scmProviderId: 'prov-1', repositoryOwner: 'Terraform', repositoryName: 'terraform-aws-networking-vpc',
        };

        it('auto-creates and SCM-links a missing module, then syncs', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{"error":"not found"}' }, // GET module
                { status: 201, body: '{"id":"mod-9"}' },         // POST create record
                { status: 201, body: '{"link_id":"lnk-1"}' },    // POST SCM link
                { status: 202, body: '' },                        // POST sync
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 4);
            assert.strictEqual(calls[1].method, 'POST');
            assert.strictEqual(calls[1].url, 'https://r.example.com/api/v1/admin/modules/create');
            assert.deepStrictEqual(JSON.parse(calls[1].body as string), { namespace: 'aceo', name: 'networking-vpc', system: 'aws' });
            assert.strictEqual(calls[2].url, 'https://r.example.com/api/v1/admin/modules/mod-9/scm');
            assert.deepStrictEqual(JSON.parse(calls[2].body as string), {
                provider_id: 'prov-1', repository_owner: 'Terraform', repository_name: 'terraform-aws-networking-vpc',
                default_branch: 'main', tag_pattern: 'v*',
            });
            assert.strictEqual(calls[3].url, 'https://r.example.com/api/v1/admin/modules/mod-9/scm/sync');
        });

        it('tolerates a 409 (already linked) during auto-create and still syncs', async () => {
            const { client, calls } = fakeClient([
                { status: 404, body: '{}' },                        // GET module
                { status: 200, body: '{"id":"mod-9"}' },            // POST create (already exists)
                { status: 409, body: '{"error":"already linked"}' }, // POST SCM link -> tolerated
                { status: 202, body: '' },                           // POST sync
            ]);
            const result = await new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 4);
            assert.strictEqual(calls[3].url, 'https://r.example.com/api/v1/admin/modules/mod-9/scm/sync');
        });

        it('still throws on 404 when auto-create inputs are incomplete', async () => {
            const partial = { ...opts, scmProviderId: 'prov-1' }; // missing owner + name
            const { client } = fakeClient([{ status: 404, body: '{}' }]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, partial, noop).publish(),
                /not found in the registry/,
            );
        });

        it('surfaces a failed create (non-2xx) as an error', async () => {
            const { client } = fakeClient([
                { status: 404, body: '{}' },                     // GET module
                { status: 403, body: '{"error":"forbidden"}' },  // POST create fails (4xx, not retried)
            ]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, autoOpts, noop).publish(),
                /Failed to create module/,
            );
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

        it('bounds the wait by the deadline and throws on timeout', async () => {
            const { client } = fakeClient([
                { status: 200, body: '{"id":"mod-1","versions":[]}' }, // resolve module
                { status: 202, body: '' },                              // trigger sync
                { status: 200, body: '{"id":"mod-1","versions":[]}' },  // poll: still absent
            ]);
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, { ...opts, waitForPublish: true, timeoutSeconds: 0 }, noop).publish(),
                /Timed out after 0s/,
            );
        });

        it('swallows a failing poll and still bounds by the deadline', async () => {
            let n = 0;
            const client: HttpClient = () => {
                n += 1;
                if (n === 1) return Promise.resolve({ status: 200, body: '{"id":"mod-1","versions":[]}' });
                if (n === 2) return Promise.resolve({ status: 202, body: '' });
                return Promise.reject(new Error('ECONNRESET')); // poll fails, must not propagate
            };
            await assert.rejects(
                () => new priv.PrivateRegistryPublisher(client, { ...opts, waitForPublish: true, timeoutSeconds: 0 }, noop).publish(),
                (err: Error) => /Timed out after 0s/.test(err.message) && !/ECONNRESET/.test(err.message),
            );
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

        it('swallows a failing status poll and bounds by the deadline', async () => {
            let n = 0;
            const client: HttpClient = () => {
                n += 1;
                if (n === 1) return Promise.resolve({ status: 200, body: '{"data":{"attributes":{"version-statuses":[]}}}' });
                if (n === 2) return Promise.resolve({ status: 201, body: '{}' });
                return Promise.reject(new Error('ETIMEDOUT')); // poll fails, must not propagate
            };
            await assert.rejects(
                () => new hcp.HcpPublisher(client, { ...base, waitForPublish: true, timeoutSeconds: 0 }, noop).publish(),
                (err: Error) => /Timed out after 0s/.test(err.message) && !/ETIMEDOUT/.test(err.message),
            );
        });
    });
});

// Mock-run tests that actually execute src/index.ts (the orchestrator). The publisher
// modules and the http transport are stubbed in each data file so no real network call
// is made; we assert the credential is masked via setSecret on both routing paths.
describe('index orchestrator (setSecret masking + publisher routing)', () => {
    before(() => {
        // MockTestRunner spawns the data file as a child process; make sure it uses the
        // same node binary running the tests rather than a NODE_OPTIONS-tainted one.
        delete process.env.NODE_OPTIONS;
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    it('masks the apiKey and routes to the private publisher', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishPrivateApiKey.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.indexOf('##vso[task.setsecret]') >= 0,
                'apiKey should be registered as a secret via setSecret',
            );
            // The private publisher mock returns this message; proves the private branch ran.
            assert.ok(
                tr.stdout.indexOf('Sync triggered for version 1.0.0.') >= 0,
                'private publisher branch should have been taken',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });

    it('masks the hcpToken and routes to the HCP publisher', async () => {
        const tr = new ttm.MockTestRunner(path.join(__dirname, 'PublishHcpToken.js'));
        await tr.runAsync();
        try {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.indexOf('##vso[task.setsecret]') >= 0,
                'hcpToken should be registered as a secret via setSecret',
            );
            // The HCP publisher mock returns this message; proves the HCP branch ran.
            assert.ok(
                tr.stdout.indexOf('Version 1.0.0 published to HCP Terraform.') >= 0,
                'HCP publisher branch should have been taken',
            );
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    });
});
