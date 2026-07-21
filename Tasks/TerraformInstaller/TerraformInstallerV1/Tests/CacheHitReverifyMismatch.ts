import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'CacheHitReverifyMismatchL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'hashicorp');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

const ZIP_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const FRESH_EXE_HASH = '2222222222222222222222222222222222222222222222222222222222222222';
const CACHED_EXE_HASH = '3333333333333333333333333333333333333333333333333333333333333333';

// No stored integrity marker exists, so the installer re-downloads the release
// through the normal verified path. The freshly verified executable's hash does
// NOT match the cached executable: the cached copy was cached unverified (or
// tampered with) and must be rejected — this is the #496 threat scenario where a
// job that demands verification would otherwise silently reuse an unverified
// cache entry seeded by an earlier job.
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
        if (p.includes('terraform-fresh')) {
            return Buffer.from('fresh-exe-content');
        }
        return Buffer.from('cached-exe-content');
    },
    createReadStream: (p: string) => {
        let content = 'cached-exe-content';
        if (p.includes('terraform-reverify')) {
            content = 'fresh-zip-content';
        } else if (p.includes('terraform-fresh')) {
            content = 'fresh-exe-content';
        }
        return require('stream').Readable.from(Buffer.from(content));
    },
    writeFileSync: () => {
        throw new Error('writeFileSync should not be called when re-verification rejects the cached copy');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const chunks: Buffer[] = [];
        const hash: any = new (require('stream').Writable)({
            write(chunk: any, _enc: any, cb: any) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                cb();
            }
        });
        hash.digest = (_encoding: string) => {
            const s = Buffer.concat(chunks).toString();
            if (s === 'fresh-zip-content') return ZIP_HASH;
            if (s === 'fresh-exe-content') return FRESH_EXE_HASH;
            return CACHED_EXE_HASH;
        };
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/terraform-cached',
    downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform-reverify.zip',
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
