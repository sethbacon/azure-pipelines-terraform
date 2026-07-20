import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// registryAllowedHosts is set and the registry's download_url host matches a
// wildcard entry — the download should proceed normally.
const tp = path.join(__dirname, 'RegistryAllowedHostAcceptL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'terraform');
tr.setInput('registryAllowedHosts', 'other.example.com, *.storage.example.com');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64',
    tmpdir: () => 'C:\\fake-temp'
});

const EXPECTED_SHA256 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        if (url.includes('/terraform/binaries/terraform/versions/1.9.8/windows/amd64')) {
            return {
                os: 'windows',
                arch: 'amd64',
                version: '1.9.8',
                sha256: EXPECTED_SHA256,
                download_url: 'https://bucket-1.storage.example.com/signed/terraform_1.9.8_windows_amd64.zip'
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called for registry download. Called with: ' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 600000,
    // downloadToFile replaces tools.downloadTool() only on the
    // registryAllowedHosts-enabled path (#679) -- genuinely exercises the
    // isHostAllowed callback terraform-installer.ts builds (real
    // isRegistryHostAllowed logic), proving the wildcard-matched host is
    // accepted, but stubs out the actual network/disk work the same way
    // downloadTool is stubbed below. fs.readFileSync is mocked to always
    // return fake-zip-content regardless of path, so no real file needs to
    // be written to destPath.
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
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
    chmodSync: (_path: string, _mode: string) => { },
    readFileSync: (_path: string) => Buffer.from('fake-zip-content')
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => ({
        update: (_data: any) => ({
            digest: (_encoding: string) => EXPECTED_SHA256
        })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => '/tmp/terraform.zip',
    extractZip: async (_zipPath: string) => '/tmp/terraform-extracted',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => '/tmp/terraform-cached',
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
