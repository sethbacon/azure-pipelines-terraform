import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// forceOnlineReverification=true on the TOFU path (downloadTerraform's terraform
// path is covered by CacheHitVerifyPassForced; this proves the SEPARATE tofu call
// site was not missed — a mutation dropping only the tofu OR-condition survived
// against CacheHitVerifyPassForced alone).
const tp = path.join(__dirname, 'CacheHitVerifyPassForcedTofuL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('forceOnlineReverification', 'true');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

// One fixed digest for everything: the stored marker, the published SHA256SUMS
// entry, and every file crypto hashes over the course of the run. Making them
// all equal is what proves a genuine match, not a mocking shortcut that happens
// to avoid the comparisons entirely.
const FIXED_HASH = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a specific version. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${FIXED_HASH}  tofu_1.11.6_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    },
    fetchBuffer: async (url: string) => {
        throw new Error('fetchBuffer should not be called in this test. Called with: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    existsSync: (p: string) => p.includes('.installer-verified.sha256'), // marker EXISTS
    readFileSync: (_p: string, _enc?: string) => FIXED_HASH,
    createReadStream: (_p: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    writeFileSync: (p: string, _data: any, _enc?: string) => {
        console.log('MARKER_WRITTEN:' + p);
    },
    unlinkSync: (_p: string) => { },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => FIXED_HASH;
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/tofu-cached',
    downloadTool: async (url: string, _fileName: string) => {
        console.log('REVERIFY_DOWNLOAD_CALLED:' + url);
        return '/tmp/tofu-reverify.zip';
    },
    extractZip: async (_zipPath: string) => '/tmp/tofu-fresh',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called on a cache hit');
    },
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/tofu-cached': ['/tmp/tofu-cached/tofu.exe'],
        '/tmp/tofu-fresh': ['/tmp/tofu-fresh/tofu.exe']
    }
};

tr.setAnswers(a);
tr.run();
