import { describe, it, afterEach } from 'mocha';
import assert = require('assert');
import tasks = require('azure-pipelines-task-lib/task');
import { HttpClient, HttpResponse, HttpPreflightError } from '../src/http';
import * as hcp from '../src/hcp-publisher';

const noop = (): void => { /* suppress log output during tests */ };

interface Recorded {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
}

/** A scripted HttpClient: replays the given responses in order (repeating the last); an Error rejects. */
function script(responses: Array<HttpResponse | Error>): { client: HttpClient; calls: Recorded[] } {
    const calls: Recorded[] = [];
    let i = 0;
    const client: HttpClient = (method, url, headers, body) => {
        calls.push({ method, url, headers, body });
        const next = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return { client, calls };
}

const base: hcp.HcpOptions = {
    namespace: 'acme', name: 'vpc', provider: 'aws', version: '1.0.0',
    address: 'https://app.terraform.io', token: 'super-secret-token',
    publishMode: 'auto', moduleDirectory: '.',
    vcsRepoIdentifier: '', vcsBranch: 'main', vcsOauthTokenId: '', commitSha: 'sha',
    waitForPublish: false, timeoutSeconds: 5,
};
const vcsOpts = { vcsRepoIdentifier: 'acme/proj/_git/terraform-aws-vpc', vcsOauthTokenId: 'ot-abc' };

const UPLOAD = 'https://archivist.terraform.io/v1/object/abc123secretpath';
const ARCHIVE = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
const archiveOk = (): Promise<Uint8Array> => Promise.resolve(ARCHIVE);

type Kind = 'branch' | 'tag' | 'none';
/** A GET-module response body for each kind of module, with the given version statuses. */
function mod(kind: Kind, statuses: Array<[string, string]> = []): HttpResponse {
    const attributes: Record<string, unknown> = {
        'version-statuses': statuses.map(([version, status]) => ({ version, status })),
    };
    if (kind !== 'none') {
        attributes['vcs-repo'] = { branch: kind === 'branch' ? 'main' : '' };
    }
    return { status: 200, body: JSON.stringify({ data: { attributes } }) };
}
const created = (upload?: string): HttpResponse => ({
    status: 201,
    body: JSON.stringify({ data: { links: upload ? { upload } : {} } }),
});
const NOT_FOUND: HttpResponse = { status: 404, body: '{}' };
const OK_EMPTY: HttpResponse = { status: 200, body: '' };

describe('hcp publish paths', () => {
    describe('mode detection and bodies', () => {
        it('detects the module kind from vcs-repo', () => {
            assert.strictEqual(hcp.moduleMode(mod('none').body), 'upload');
            assert.strictEqual(hcp.moduleMode(mod('branch').body), 'vcsBranch');
            assert.strictEqual(hcp.moduleMode(mod('tag').body), 'vcsTag');
            // HCP reports a tag module's branch as "" or null depending on the endpoint.
            assert.strictEqual(
                hcp.moduleMode('{"data":{"attributes":{"vcs-repo":{"branch":null,"tags":true}}}}'),
                'vcsTag',
            );
            assert.strictEqual(hcp.moduleMode('{"data":{"attributes":{"vcs-repo":null}}}'), 'upload');
            assert.strictEqual(hcp.moduleMode('{}'), 'upload');
        });

        it('matches a v-prefixed version against the normalised version HCP stores', () => {
            const body = mod('branch', [['1.0.0', 'ok']]).body;
            assert.strictEqual(hcp.versionStatus(body, 'v1.0.0'), 'ok');
            assert.strictEqual(hcp.versionStatus(body, '1.0.0'), 'ok');
        });

        it('tolerates version-statuses arriving as a bare object instead of an array', () => {
            const body = '{"data":{"attributes":{"version-statuses":{"version":"1.0.0","status":"ok"}}}}';
            assert.strictEqual(hcp.versionStatus(body, '1.0.0'), undefined);
        });

        it('omits branch from a tag-based VCS create body and keeps it for a branch-based one', () => {
            const o = { ...base, ...vcsOpts };
            const branch = JSON.parse(hcp.vcsModuleBody(o)).data.attributes['vcs-repo'];
            const tag = JSON.parse(hcp.vcsModuleBody(o, true)).data.attributes['vcs-repo'];
            assert.strictEqual(branch.branch, 'main');
            assert.ok(!('branch' in tag), 'a tag-based module must not send branch');
            assert.strictEqual(tag.identifier, 'acme/proj/_git/terraform-aws-vpc');
            assert.strictEqual(tag['oauth-token-id'], 'ot-abc');
        });

        it('builds the no-VCS create body without a namespace (HCP rejects it for a private module)', () => {
            const parsed = JSON.parse(hcp.noVcsModuleBody(base));
            assert.deepStrictEqual(parsed.data.attributes, {
                name: 'vpc', provider: 'aws', 'registry-name': 'private', 'no-code': false,
            });
            assert.strictEqual(hcp.modulesUrl('https://app.terraform.io/', 'acme'),
                'https://app.terraform.io/api/v2/organizations/acme/registry-modules');
        });
    });

    describe('no-VCS module (upload)', () => {
        it('creates the module, creates the version, then uploads the archive without the bearer token', async () => {
            const { client, calls } = script([NOT_FOUND, created(), created(UPLOAD), OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();

            assert.strictEqual(result.published, true);
            assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST', 'POST', 'PUT']);
            assert.strictEqual(calls[1].url, hcp.modulesUrl(base.address, base.namespace));
            assert.strictEqual(calls[2].url, hcp.versionsUrl(base));
            const put = calls[3];
            assert.strictEqual(put.url, UPLOAD);
            assert.strictEqual(put.body, ARCHIVE, 'the archive bytes are sent as-is, not stringified');
            assert.strictEqual(put.headers['Content-Type'], 'application/octet-stream');
            assert.ok(
                !Object.keys(put.headers).some((h) => h.toLowerCase() === 'authorization'),
                'the HCP token must never be sent to the upload link',
            );
            assert.ok(calls.slice(0, 3).every((c) => c.headers.Authorization === 'Bearer super-secret-token'));
        });

        it('uploads to an existing no-VCS module without recreating it', async () => {
            const { client, calls } = script([mod('none'), created(UPLOAD), OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST', 'PUT']);
            assert.strictEqual(calls[1].url, hcp.versionsUrl(base));
        });

        it('builds the archive from moduleDirectory before creating anything', async () => {
            const events: string[] = [];
            const responses = [NOT_FOUND, created(), created(UPLOAD), OK_EMPTY];
            let requests = 0;
            const client: HttpClient = (method) => {
                events.push(method);
                requests += 1;
                return Promise.resolve(responses[requests - 1]);
            };
            const dirs: string[] = [];
            await new hcp.HcpPublisher(client, { ...base, moduleDirectory: 'modules/vpc' }, noop, (dir) => {
                events.push('archive');
                dirs.push(dir);
                return archiveOk();
            }).publish();
            assert.deepStrictEqual(events.slice(0, 3), ['GET', 'archive', 'POST']);
            assert.deepStrictEqual(dirs, ['modules/vpc']);
        });

        it('creates no module when the archive cannot be built', async () => {
            const { client, calls } = script([NOT_FOUND]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, () => Promise.reject(new Error('no .tf files'))).publish(),
                /no \.tf files/,
            );
            assert.strictEqual(calls.length, 1, 'only the GET: nothing may be created before the archive is known good');
        });

        it('fails when HCP returns no upload link for a no-VCS module', async () => {
            const { client } = script([mod('none'), created()]);
            await assert.rejects(() => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(), /HcpNoUploadLink|did not return an upload link/);
        });

        it('refuses a non-https upload link and never PUTs to it', async () => {
            const { client, calls } = script([mod('none'), created('http://archivist.terraform.io/v1/object/x')]);
            await assert.rejects(() => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(), /HcpUploadUrlInvalid|not a valid https/);
            assert.ok(!calls.some((c) => c.method === 'PUT'));
        });

        it('refuses an unparseable upload link', async () => {
            const { client } = script([mod('none'), created('not a url')]);
            await assert.rejects(() => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(), /HcpUploadUrlInvalid|not a valid https/);
        });

        it('registers the upload link with the log masker before using it', async () => {
            const secrets: string[] = [];
            const original = tasks.setSecret;
            (tasks as unknown as { setSecret: (s: string) => void }).setSecret = (s) => { secrets.push(s); };
            try {
                const { client } = script([mod('none'), created(UPLOAD), OK_EMPTY]);
                await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            } finally {
                (tasks as unknown as { setSecret: typeof original }).setSecret = original;
            }
            assert.ok(secrets.includes(UPLOAD), 'the capability URL must be masked');
        });

        it('scrubs the upload link from a failed-upload error', async () => {
            const { client } = script([mod('none'), created(UPLOAD), { status: 403, body: `denied for ${UPLOAD}` }]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(),
                (err: Error) => /HcpUploadFailed|upload failed/.test(err.message) && !err.message.includes('abc123secretpath'),
            );
        });

        it('scrubs the upload link from a transport error', async () => {
            // HttpPreflightError is not retried, which keeps this fast.
            const boom = new HttpPreflightError(`could not reach ${UPLOAD}`, undefined);
            const { client } = script([mod('none'), created(UPLOAD), boom]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(),
                (err: Error) => /HcpUploadRequestFailed|upload failed/.test(err.message) && !err.message.includes('abc123secretpath'),
            );
        });

        it('retries a transient 5xx on the upload PUT (re-PUT of the same link is safe)', async () => {
            const { client, calls } = script([mod('none'), created(UPLOAD), { status: 503, body: '' }, OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.filter((c) => c.method === 'PUT').length, 2);
        });
    });

    describe('creating a module that does not exist', () => {
        it('auto + both VCS inputs creates a branch-based VCS module', async () => {
            const { client, calls } = script([NOT_FOUND, created(), created()]);
            await new hcp.HcpPublisher(client, { ...base, ...vcsOpts }, noop, archiveOk).publish();
            assert.strictEqual(calls[1].url, hcp.vcsUrl(base.address, base.namespace));
            assert.strictEqual(JSON.parse(calls[1].body as string).data.attributes['vcs-repo'].branch, 'main');
            assert.ok(!calls.some((c) => c.method === 'PUT'), 'a branch module with no upload link uploads nothing');
        });

        it('a branch module ignores the upload link HCP also returns (live: it is ingested from the commit)', async () => {
            let built = 0;
            const build = (): Promise<Uint8Array> => { built += 1; return archiveOk(); };
            const { client, calls } = script([mod('branch'), created(UPLOAD)]);
            const result = await new hcp.HcpPublisher(client, { ...base, ...vcsOpts }, noop, build).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(built, 0, 'moduleDirectory must not be archived for a branch module');
            assert.ok(!calls.some((c) => c.method === 'PUT'), 'nothing is uploaded to a branch module');
        });

        it('auto + both VCS inputs but an empty branch creates a tag-based module', async () => {
            const { client, calls } = script([NOT_FOUND, created()]);
            await new hcp.HcpPublisher(client, { ...base, ...vcsOpts, vcsBranch: '' }, noop, archiveOk).publish();
            assert.ok(!('branch' in JSON.parse(calls[1].body as string).data.attributes['vcs-repo']));
        });

        for (const [present, missing] of [
            [{ vcsRepoIdentifier: 'a/b/_git/c' }, 'vcsOauthTokenId'],
            [{ vcsOauthTokenId: 'ot-abc' }, 'vcsRepoIdentifier'],
        ] as const) {
            it(`auto + only one VCS input fails naming the missing ${missing} and creates nothing`, async () => {
                const { client, calls } = script([NOT_FOUND]);
                await assert.rejects(
                    () => new hcp.HcpPublisher(client, { ...base, ...present }, noop, archiveOk).publish(),
                    new RegExp(missing),
                );
                assert.strictEqual(calls.length, 1);
            });
        }

        it('explicit upload creates a no-VCS module and says the VCS inputs are ignored', async () => {
            const logs: string[] = [];
            const { client, calls } = script([NOT_FOUND, created(), created(UPLOAD), OK_EMPTY]);
            await new hcp.HcpPublisher(client, { ...base, ...vcsOpts, publishMode: 'upload' }, (m) => logs.push(m), archiveOk).publish();
            assert.strictEqual(calls[1].url, hcp.modulesUrl(base.address, base.namespace));
            assert.ok(logs.some((l) => /HcpVcsInputsIgnored|ignored/.test(l)));
        });

        for (const mode of ['vcsBranch', 'vcsTag'] as const) {
            it(`explicit ${mode} without VCS inputs fails and creates nothing`, async () => {
                const { client, calls } = script([NOT_FOUND]);
                await assert.rejects(
                    () => new hcp.HcpPublisher(client, { ...base, publishMode: mode }, noop, archiveOk).publish(),
                    /HcpVcsModeNeedsInputs|needs both vcsRepoIdentifier and vcsOauthTokenId/,
                );
                assert.strictEqual(calls.length, 1);
            });
        }

        it('explicit vcsBranch with an empty branch fails', async () => {
            const { client } = script([NOT_FOUND]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, { ...base, ...vcsOpts, publishMode: 'vcsBranch', vcsBranch: '' }, noop, archiveOk).publish(),
                /HcpVcsBranchRequired|needs vcsBranch/,
            );
        });

        // Live: HCP named the module after the repo and ignored name/provider, leaving an orphan + webhook.
        for (const [label, overrides] of [
            ['name', { name: 'network' }],
            ['provider', { provider: 'azurerm' }],
        ] as const) {
            it(`refuses a repo whose name implies a different module ${label} and creates nothing`, async () => {
                const { client, calls } = script([NOT_FOUND]);
                await assert.rejects(
                    () => new hcp.HcpPublisher(client, { ...base, ...vcsOpts, ...overrides }, noop, archiveOk).publish(),
                    /HcpVcsRepoNameMismatch|names a VCS-connected module from its repository/,
                );
                assert.strictEqual(calls.length, 1, 'only the GET: no module or hook may be created');
            });
        }

        it('matches the repo name against name and provider case-insensitively', async () => {
            const { client } = script([NOT_FOUND, created(), created()]);
            const opts = { ...base, ...vcsOpts, vcsRepoIdentifier: 'acme/proj/_git/Terraform-AWS-VPC' };
            await new hcp.HcpPublisher(client, opts, noop, archiveOk).publish();
        });

        it('leaves a repo that does not follow terraform-<provider>-<name> to HCP to judge', async () => {
            const { client, calls } = script([NOT_FOUND, created(), created()]);
            await new hcp.HcpPublisher(client, { ...base, vcsRepoIdentifier: 'a/b/_git/infra-modules', vcsOauthTokenId: 'ot-abc' }, noop, archiveOk).publish();
            assert.strictEqual(calls[1].url, hcp.vcsUrl(base.address, base.namespace));
        });

        it('reports the create error when it fails and the module still does not exist', async () => {
            const { client } = script([NOT_FOUND, { status: 403, body: 'forbidden' }, NOT_FOUND]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(),
                /HcpCreateModuleFailed|Failed to create HCP module/,
            );
        });

        it('converges when the module appeared meanwhile (lost response or concurrent run)', async () => {
            const { client, calls } = script([NOT_FOUND, { status: 422, body: 'Provider must be unique' }, mod('none'), created(UPLOAD), OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST', 'GET', 'POST', 'PUT']);
        });

        it('does not converge onto a module of a different kind than intended', async () => {
            const { client } = script([NOT_FOUND, { status: 422, body: 'Provider must be unique' }, mod('branch')]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(),
                /HcpCreateModuleFailed|Failed to create HCP module/,
            );
        });
    });

    describe('explicit mode against an existing module', () => {
        for (const [requested, existing, kind] of [
            ['vcsTag', 'vcsBranch', 'branch'],
            ['vcsBranch', 'upload', 'none'],
            ['upload', 'vcsTag', 'tag'],
        ] as const) {
            it(`${requested} against a ${existing} module fails before changing anything`, async () => {
                const { client, calls } = script([mod(kind)]);
                await assert.rejects(
                    () => new hcp.HcpPublisher(client, { ...base, publishMode: requested }, noop, archiveOk).publish(),
                    new RegExp(`HcpPublishModeMismatch|is a '${existing}' module`),
                );
                assert.strictEqual(calls.length, 1);
            });
        }

        it('an explicit mode that matches the module proceeds', async () => {
            const { client } = script([mod('none'), created(UPLOAD), OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, { ...base, publishMode: 'upload' }, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
        });
    });

    describe('tag-based module (observe only)', () => {
        it('creates the module without a branch and does not create a version', async () => {
            const { client, calls } = script([NOT_FOUND, created()]);
            const result = await new hcp.HcpPublisher(client, { ...base, ...vcsOpts, publishMode: 'vcsTag' }, noop, archiveOk).publish();
            assert.strictEqual(result.published, false);
            assert.ok(!('branch' in JSON.parse(calls[1].body as string).data.attributes['vcs-repo']));
            assert.ok(!calls.some((c) => c.url === hcp.versionsUrl(base)), 'versions come from git tags, never the API');
            assert.strictEqual(calls.length, 2);
        });

        it('reports an existing ok version as already published without waiting', async () => {
            const { client, calls } = script([mod('tag', [['1.0.0', 'ok']])]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, false);
            assert.strictEqual(calls.length, 1);
        });

        it('waits for the tag-driven version to appear when waitForPublish is set', async () => {
            const { client, calls } = script([mod('tag'), mod('tag', [['1.0.0', 'ok']])]);
            const result = await new hcp.HcpPublisher(client, { ...base, waitForPublish: true }, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.ok(calls.every((c) => c.method === 'GET'), 'a tag-based module is never written to');
        });

        it('fails fast when the tag-driven version fails ingestion', async () => {
            const { client } = script([mod('tag'), mod('tag', [['1.0.0', 'reg_ingress_failed']])]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, { ...base, waitForPublish: true }, noop, archiveOk).publish(),
                /HcpVersionIngestFailed|failed to process/,
            );
        });
    });

    describe('recovering a stuck version', () => {
        // Live-verified: the delete endpoint has no /versions/ segment (that form 404s).
        const versionUrl = `${hcp.moduleUrl(base)}/1.0.0`;

        for (const status of ['reg_ingress_failed', 'pending']) {
            it(`deletes and recreates a ${status} version of a no-VCS module so a pipeline retry can succeed`, async () => {
                const { client, calls } = script([mod('none', [['1.0.0', status]]), { status: 204, body: '' }, created(UPLOAD), OK_EMPTY]);
                const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
                assert.strictEqual(result.published, true);
                assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'DELETE', 'POST', 'PUT']);
                assert.strictEqual(calls[1].url, versionUrl);
            });
        }

        it('deletes and recreates a failed version of a branch module', async () => {
            const { client, calls } = script([mod('branch', [['1.0.0', 'reg_ingress_failed']]), { status: 204, body: '' }, created()]);
            await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'DELETE', 'POST']);
        });

        it('does not delete a pending version of a branch module; it waits for it instead', async () => {
            const { client, calls } = script([mod('branch', [['1.0.0', 'pending']])]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.strictEqual(calls.length, 1, 'no DELETE and no POST');
        });

        it('tolerates the stuck version already being gone (404 on delete)', async () => {
            const { client } = script([mod('none', [['1.0.0', 'pending']]), { status: 404, body: '{}' }, created(UPLOAD), OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
        });

        it('fails when the stuck version cannot be deleted', async () => {
            const { client } = script([mod('none', [['1.0.0', 'pending']]), { status: 403, body: 'no' }]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(),
                /HcpDeleteVersionFailed|Failed to delete the stuck version/,
            );
        });
    });

    describe('version create 422 handling', () => {
        const branchModule = mod('branch');

        it('reports a version that turned out to be ok as already published', async () => {
            const { client } = script([branchModule, { status: 422, body: 'Version has already been taken' }, mod('branch', [['1.0.0', 'ok']])]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, false);
        });

        it('carries on when the version exists and is still being ingested', async () => {
            const { client } = script([branchModule, { status: 422, body: 'Version has already been taken' }, mod('branch', [['1.0.0', 'reg_ingressing']])]);
            const result = await new hcp.HcpPublisher(client, base, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
        });

        it('fails on a 422 that is not "already exists" (malformed version)', async () => {
            const { client } = script([branchModule, { status: 422, body: 'Malformed version 1.0' }, branchModule]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, { ...base, version: '1.0' }, noop, archiveOk).publish(),
                /HcpCreateVersionFailed|Malformed version/,
            );
        });

        it('fails on a non-422 error status', async () => {
            const { client } = script([branchModule, { status: 403, body: 'nope' }]);
            await assert.rejects(
                () => new hcp.HcpPublisher(client, base, noop, archiveOk).publish(),
                /HcpCreateVersionFailed|Failed to create version/,
            );
        });
    });

    describe('waiting', () => {
        it('succeeds as soon as the version is ok', async () => {
            const { client } = script([mod('branch'), created(), mod('branch', [['1.0.0', 'ok']])]);
            const result = await new hcp.HcpPublisher(client, { ...base, waitForPublish: true }, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
        });

        it('fails immediately on reg_ingress_failed instead of running out the timeout', async () => {
            const { client } = script([mod('none'), created(UPLOAD), OK_EMPTY, mod('none', [['1.0.0', 'reg_ingress_failed']])]);
            const started = Date.now();
            await assert.rejects(
                () => new hcp.HcpPublisher(client, { ...base, waitForPublish: true, timeoutSeconds: 120 }, noop, archiveOk).publish(),
                /HcpVersionIngestFailed|failed to process/,
            );
            assert.ok(Date.now() - started < 2000, 'must not poll to the 120s deadline');
        });

        it('matches a v-prefixed version input against the normalised stored version', async () => {
            const { client, calls } = script([mod('branch', [['1.0.0', 'ok']])]);
            const result = await new hcp.HcpPublisher(client, { ...base, version: 'v1.0.0' }, noop, archiveOk).publish();
            assert.strictEqual(result.published, false);
            assert.strictEqual(calls.length, 1);
        });
    });

    describe('module check returns an unexpected status', () => {
        it('auto: carries on to create the version without assuming an upload', async () => {
            const logs: string[] = [];
            const { client, calls } = script([{ status: 403, body: '{}' }, created()]);
            const result = await new hcp.HcpPublisher(client, base, (m) => logs.push(m), archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST']);
            assert.ok(logs.some((l) => /HcpCheckModuleFailed|Could not check/.test(l)));
        });

        it('explicit upload: carries on and uploads the archive', async () => {
            const { client, calls } = script([{ status: 403, body: '{}' }, created(UPLOAD), OK_EMPTY]);
            const result = await new hcp.HcpPublisher(client, { ...base, publishMode: 'upload' }, noop, archiveOk).publish();
            assert.strictEqual(result.published, true);
            assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST', 'PUT']);
        });
    });

    afterEach(() => { /* each test builds its own client; nothing shared to reset */ });
});
