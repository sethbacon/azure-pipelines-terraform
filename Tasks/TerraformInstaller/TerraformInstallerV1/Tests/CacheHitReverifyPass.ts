import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CacheHitReverifyPassL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

const ZIP_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const EXE_HASH = '2222222222222222222222222222222222222222222222222222222222222222';

// No stored integrity marker exists, so the installer re-downloads the release
// through the normal verified path. The freshly verified executable byte-matches
// the cached one, so the cache entry is accepted AND an integrity marker is
// written (healing the entry: future cache hits verify locally, offline).
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a specific version. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
            return `${ZIP_HASH}  terraform_1.9.8_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async (_sha256SumsContent: string, _signatureUrl: string) => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (p: string, _enc?: string) => {
        if (p.includes('terraform-reverify')) {
            return Buffer.from('fresh-zip-content');
        }
        // The freshly extracted executable and the cached executable carry the
        // same bytes — the cached entry matches the verified release.
        return Buffer.from('shared-exe-content');
    },
    writeFileSync: (p: string, _data: any, _enc?: string) => {
        console.log('MARKER_WRITTEN:' + p);
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => ({
        update: (data: any) => ({
            digest: (_encoding: string) => {
                const s = data.toString();
                if (s === 'fresh-zip-content') return ZIP_HASH;
                return EXE_HASH;
            }
        })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (url: string, _fileName: string) => {
        console.log('REVERIFY_DOWNLOAD_CALLED:' + url);
        return '/tmp/terraform-reverify.zip';
    },
    extractZip: async (_zipPath: string) => '/tmp/terraform-fresh',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called on a cache hit');
    },
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/terraform-cached': ['/tmp/terraform-cached/terraform.exe'],
        '/tmp/terraform-fresh': ['/tmp/terraform-fresh/terraform.exe']
    }
};

tr.setAnswers(a);
tr.run();
