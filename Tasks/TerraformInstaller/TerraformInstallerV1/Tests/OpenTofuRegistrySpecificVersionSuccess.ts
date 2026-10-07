import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// binary=tofu with downloadSource=registry installs OpenTofu from the operator's own
// registry (an OpenTofu mirror, registryMirrorName=opentofu) instead of GitHub.
//
// This registry advertises NO shasums_url / shasums_signature_url -- an older
// terraform-registry-backend, a mirror with GPG verification disabled, or a version synced
// before either existed. There is then nothing to verify a signature against, so neither
// fetchText nor the GPG verifier may be reached: the only trust anchor is the registry's
// own sha256, and the install must say so. Sibling of OpenTofuRegistryGpgVerified.ts,
// where the registry does advertise OpenTofu's signed SHA256SUMS.
const tp = path.join(__dirname, 'OpenTofuRegistrySpecificVersionSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'opentofu');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64',
    tmpdir: () => '/tmp'
});

// storage.example.com is a fictional host; resolve it to a public address so the
// private-address check passes without a real lookup.
tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url === 'https://registry.example.com/terraform/binaries/opentofu/versions/1.11.6/windows/amd64') {
            return {
                os: 'windows',
                arch: 'amd64',
                version: '1.11.6',
                filename: 'tofu_1.11.6_windows_amd64.zip',
                sha256: EXPECTED_SHA256,
                download_url: 'https://storage.example.com/signed/tofu_1.11.6_windows_amd64.zip'
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText must not be called: the registry advertised no SHA256SUMS to fetch. Called with: ' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 600000,
    downloadToFile: async (url: string, destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
        console.log('DOWNLOADED:' + url + ' AS ' + path.basename(destPath));
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => {
        console.log('GPG_VERIFY_CALLED');
        return true;
    }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => {
        console.log('COSIGN_VERIFY_CALLED');
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
        throw new Error('downloadTool should not be called for a registry download -- downloadToFile must be used (#729)');
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
