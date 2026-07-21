import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const BINARY_HASH = '1111111111111111111111111111111111111111111111111111111111111111';

// No stored integrity marker exists, so the installer re-downloads the OPA
// binary through the normal verified path (OPA's published .sha256 covers the
// raw binary directly). The freshly verified binary byte-matches the cached
// one, so the cache entry is accepted AND an integrity marker is written
// (healing the entry: future cache hits verify locally, offline).
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
    fetchTextAllow404: async (url: string) => {
        if (url.endsWith('.sha256')) {
            return `${BINARY_HASH}  opa_linux_amd64\n`;
        }
        throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => Buffer.from('shared-binary-content'),
    createReadStream: (_p: string) => require('stream').Readable.from(Buffer.from('shared-binary-content')),
    writeFileSync: (p: string, _data: any, _enc?: string) => {
        console.log('MARKER_WRITTEN:' + p);
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
        hash.digest = () => Buffer.concat(chunks).toString() === 'shared-binary-content'
            ? BINARY_HASH
            : 'ffffffff00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async (url: string) => {
        console.log('REVERIFY_DOWNLOAD_CALLED:' + url);
        return '/tmp/opa-fresh-binary';
    },
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
