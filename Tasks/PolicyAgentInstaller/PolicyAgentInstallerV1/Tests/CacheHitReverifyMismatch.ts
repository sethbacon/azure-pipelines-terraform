import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const FRESH_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const CACHED_HASH = '3333333333333333333333333333333333333333333333333333333333333333';

// No stored integrity marker exists, so the installer re-downloads the OPA
// binary through the normal verified path. The freshly verified binary does NOT
// match the cached one: the cached copy was cached unverified (or tampered
// with) and must be rejected — the #496 threat scenario where a job that
// demands verification would otherwise silently reuse an unverified cache
// entry seeded by an earlier job.
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
    fetchTextAllow404: async (url: string) => {
        if (url.endsWith('.sha256')) {
            return `${FRESH_HASH}  opa_linux_amd64\n`;
        }
        throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (p: string, _enc?: string) => {
        if (p.includes('opa-fresh-binary')) {
            return Buffer.from('fresh-binary-content');
        }
        return Buffer.from('cached-binary-content');
    },
    createReadStream: (p: string) => {
        const content = p.includes('opa-fresh-binary') ? 'fresh-binary-content' : 'cached-binary-content';
        return require('stream').Readable.from(Buffer.from(content));
    },
    writeFileSync: () => {
        throw new Error('writeFileSync should not be called when re-verification rejects the cached copy');
    },
    chmodSync: () => { },
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => {
        const chunks: Buffer[] = [];
        const hash: any = new (require('stream').Writable)({
            write(chunk: any, _e: any, cb: any) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                cb();
            }
        });
        hash.digest = () => Buffer.concat(chunks).toString() === 'fresh-binary-content' ? FRESH_HASH : CACHED_HASH;
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async () => '/tmp/opa-fresh-binary',
    extractZip: async () => { throw new Error('extractZip should not be called for a raw OPA binary'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
