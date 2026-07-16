import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'sentinel');
tr.setInput('version', '0.24.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const ZIP_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const FRESH_EXE_HASH = '2222222222222222222222222222222222222222222222222222222222222222';
const CACHED_EXE_HASH = '3333333333333333333333333333333333333333333333333333333333333333';

// Sentinel variant of the re-verification mismatch: the zip is re-downloaded,
// GPG + SHA256 verified, extracted — and the extracted executable does NOT
// match the cached one, so the cached copy is rejected (fail closed).
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called for a specific version: ' + url); },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${ZIP_HASH}  sentinel_0.24.1_linux_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    },
    fetchTextAllow404: async (url: string) => { throw new Error('Unexpected fetchTextAllow404 URL: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (p: string, _enc?: string) => {
        if (p.includes('sentinel-reverify')) {
            return Buffer.from('fresh-zip-content');
        }
        if (p.includes('sentinel-fresh')) {
            return Buffer.from('fresh-exe-content');
        }
        return Buffer.from('cached-exe-content');
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
    createHash: () => ({
        update: (data: any) => ({
            digest: () => {
                const s = data.toString();
                if (s === 'fresh-zip-content') return ZIP_HASH;
                if (s === 'fresh-exe-content') return FRESH_EXE_HASH;
                return CACHED_EXE_HASH;
            }
        })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/sentinel-cached',
    downloadTool: async () => '/tmp/sentinel-reverify.zip',
    extractZip: async () => '/tmp/sentinel-fresh',
    cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: {
        '/tmp/sentinel-cached': ['/tmp/sentinel-cached/sentinel'],
        '/tmp/sentinel-fresh': ['/tmp/sentinel-fresh/sentinel']
    }
};
tr.setAnswers(a);
tr.run();
