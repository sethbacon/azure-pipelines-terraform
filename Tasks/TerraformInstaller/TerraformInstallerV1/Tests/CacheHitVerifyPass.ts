import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CacheHitVerifyPassL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

// http-client should NOT be called when tool is cached (no download, no SHA256)
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called when tool is cached. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called when tool is cached. Called with: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

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
    writeFileSync: () => {
        throw new Error('writeFileSync should not be called on a cache hit');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => ({
        update: (_data: any) => ({
            digest: (_encoding: string) => CACHED_EXE_HASH
        })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called when tool is cached');
    },
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip should not be called when tool is cached');
    },
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called when tool is cached');
    },
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/terraform-cached': ['/tmp/terraform-cached/terraform.exe']
    }
};

tr.setAnswers(a);
tr.run();
