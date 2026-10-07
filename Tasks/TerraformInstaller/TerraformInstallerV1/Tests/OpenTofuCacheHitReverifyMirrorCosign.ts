import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Cache hit for tofu with NO integrity marker and downloadSource=mirror. The reverify
// re-download must be the OpenTofu one -- the tofu_ SHA256SUMS authenticated with
// cosign -- and, when it matches the cached binary, heals the marker. The same digest is
// used for the cached binary, the fresh archive and the published checksum, so a pass
// is a genuine match rather than a mocking shortcut.
//
// Were the binary not carried into the reverify download, it would ask the mirror for
// terraform_1.11.6_SHA256SUMS (rejected below as an unexpected URL) and verify with GPG.
const tp = path.join(__dirname, 'OpenTofuCacheHitReverifyMirrorCosignL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/opentofu');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64',
    tmpdir: () => '/tmp'
});

tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

const FIXED_HASH = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const SHA256SUMS_URL = 'https://artifacts.example.com/opentofu/1.11.6/tofu_1.11.6_SHA256SUMS';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a pinned mirror download. Called with: ' + url);
    },
    fetchTextAllow404: async (url: string) => {
        if (url === SHA256SUMS_URL) {
            return `${FIXED_HASH}  tofu_1.11.6_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
    },
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
        console.log('REVERIFY_DOWNLOADED:' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => {
        console.log('GPG_VERIFY_CALLED');
        return true;
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async (_sums: string, signatureUrl: string, certificateUrl: string, version: string, required: boolean) => {
        console.log(`COSIGN_VERIFY_CALLED:${signatureUrl}|${certificateUrl}|${version}|required=${required}`);
    }
});

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    createReadStream: (_p: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    writeFileSync: (p: string, _data: any, _enc?: string) => {
        console.log('MARKER_WRITTEN:' + p);
    },
    renameSync: (_from: string, _to: string) => { },
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
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
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
