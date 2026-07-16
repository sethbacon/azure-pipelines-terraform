import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// http-client should NOT be called when the tool is cached.
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called when tool is cached: ' + url); },
    fetchTextAllow404: async (url: string) => { throw new Error('fetchTextAllow404 should not be called when tool is cached: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

const CACHED_EXE_HASH = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd001122';

// A stored integrity marker exists and matches the (mocked) hash of the cached
// executable's current on-disk content: the cache-hit re-verification must pass
// silently and skip the download path entirely.
tr.registerMock('fs', {
    existsSync: (p: string) => p.includes('.installer-verified.sha256'),
    readFileSync: (p: string, _enc?: string) => {
        if (p.includes('.installer-verified.sha256')) {
            return CACHED_EXE_HASH;
        }
        return Buffer.from('cached-exe-content');
    },
    writeFileSync: () => { throw new Error('writeFileSync should not be called on a cache hit'); },
    chmodSync: () => { },
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => CACHED_EXE_HASH }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async () => { throw new Error('downloadTool should not be called when tool is cached'); },
    extractZip: async () => { throw new Error('extractZip should not be called when tool is cached'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called when tool is cached'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
