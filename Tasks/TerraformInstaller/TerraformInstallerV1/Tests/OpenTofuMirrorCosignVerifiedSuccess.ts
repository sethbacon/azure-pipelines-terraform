import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// binary=tofu with downloadSource=mirror installs OpenTofu from a mirror laid out like
// the upstream release: {mirrorBaseUrl}/{version}/tofu_{version}_{os}_{arch}.zip beside
// tofu_{version}_SHA256SUMS, .sig and .pem (no 'v' prefix on the version).
//
// OpenTofu authenticates its SHA256SUMS with cosign, so the mirror's .sig and .pem are
// handed to the cosign verifier with the operator's cosign controls. The HashiCorp GPG
// verifier must not run: requireGpgSignature is set to true here precisely to prove it
// has no say over an OpenTofu install.
const tp = path.join(__dirname, 'OpenTofuMirrorCosignVerifiedSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const COSIGN_PIN = 'a'.repeat(64);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/opentofu');
tr.setInput('requireGpgSignature', 'true');
tr.setInput('cosignSource', 'ambient');
tr.setInput('cosignSha256', COSIGN_PIN);

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

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const SHA256SUMS_URL = 'https://artifacts.example.com/opentofu/1.11.6/tofu_1.11.6_SHA256SUMS';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for a pinned mirror download. Called with: ' + url);
    },
    fetchTextAllow404: async (url: string) => {
        if (url === SHA256SUMS_URL) {
            return `${EXPECTED_SHA256}  tofu_1.11.6_windows_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchTextAllow404 URL: ' + url);
    },
    downloadToFile: async (url: string, destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
        console.log('DOWNLOADED:' + url + ' AS ' + path.basename(destPath));
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
    verifyCosignSignature: async (
        sha256SumsContent: string,
        signatureUrl: string,
        certificateUrl: string,
        version: string,
        required: boolean,
        expectedCosignSha256?: string,
        cosignSource?: string
    ) => {
        console.log(`COSIGN_VERIFY_CALLED:${signatureUrl}|${certificateUrl}|${version}|required=${required}|pin=${expectedCosignSha256}|source=${cosignSource}`);
        console.log('COSIGN_SUMS_BODY:' + sha256SumsContent.trim());
    }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    writeFileSync: (p: string, _content: any) => {
        console.log('MARKER_WRITTEN:' + p);
    },
    renameSync: (_from: string, _to: string) => { },
    unlinkSync: (_path: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => EXPECTED_SHA256;
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
    },
    extractZip: async (_zipPath: string) => '/tmp/tofu-extracted',
    cacheDir: async (_srcPath: string, tool: string, version: string) => {
        console.log('CACHE_DIR_CALLED:' + tool + '@' + version);
        return '/tmp/tofu-cached';
    },
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {
    'find': {
        '/tmp/tofu-cached': ['/tmp/tofu-cached/tofu.exe']
    }
};

tr.setAnswers(a);
tr.run();
