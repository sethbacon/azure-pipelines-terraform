import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Cache hit for tofu with NO integrity marker, so the install re-verifies the cached
// binary against a fresh download from the configured registry. That re-download must be
// an OpenTofu one: here the registry answers from its Terraform mirror (the default
// registryMirrorName), and the wrong-archive rejection has to carry through the
// reverify path as a typed VerificationFailure -- fail closed, NOT the
// trust-the-cache degradation an unreachable source gets.
//
// Without the binary reaching the reverify download, the filename guard would not fire
// and a Terraform archive would be accepted as the proof for a cached tofu.
const tp = path.join(__dirname, 'OpenTofuCacheHitReverifyRegistryWrongMirrorL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform');
tr.setInput('requireChecksum', 'true');

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

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url === 'https://registry.example.com/terraform/binaries/terraform/versions/1.11.6/windows/amd64') {
            return {
                os: 'windows',
                arch: 'amd64',
                version: '1.11.6',
                filename: 'terraform_1.11.6_windows_amd64.zip',
                sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                download_url: 'https://storage.example.com/signed/terraform_1.11.6_windows_amd64.zip'
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called. Called with: ' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 600000,
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, _isHostAllowed: (hostname: string) => void) => {
        throw new Error('downloadToFile must not be reached: the filename guard has to reject the wrong mirror first. Called with: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => Buffer.from('cached-exe-content'),
    writeFileSync: () => {
        throw new Error('writeFileSync must not be called when re-verification fails closed');
    },
    chmodSync: (_path: string, _mode: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => ({
        update: (_data: unknown) => ({ digest: (_encoding: string) => 'unused' })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/tofu-cached',
    downloadTool: async (_url: string, _fileName: string) => '/tmp/tofu-reverify.zip',
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip must not be reached when the reverify download is rejected');
    },
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called on a cache hit');
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
