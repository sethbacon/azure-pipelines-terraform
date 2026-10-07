import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// binary=tofu from a registry that returns an EMPTY sha256, with the operator having
// opted out of requireChecksum. The install proceeds, warns that local verification was
// skipped, and -- because nothing was verified -- must NOT write the cache integrity
// marker: a marker is the record that this artifact was checked, and a later cache hit
// would otherwise skip the online re-verification it still needs.
const tp = path.join(__dirname, 'OpenTofuRegistryEmptySha256UnverifiedL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('registryMirrorName', 'opentofu');
tr.setInput('requireChecksum', 'false');

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
        if (url === 'https://registry.example.com/terraform/binaries/opentofu/versions/1.11.6/windows/amd64') {
            return {
                os: 'windows',
                arch: 'amd64',
                version: '1.11.6',
                filename: 'tofu_1.11.6_windows_amd64.zip',
                sha256: '',
                download_url: 'https://storage.example.com/signed/tofu_1.11.6_windows_amd64.zip'
            };
        }
        throw new Error('Unexpected fetchJson URL: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called for a registry download. Called with: ' + url);
    },
    DOWNLOAD_TIMEOUT_MS: 600000,
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

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
        hash.digest = (_encoding: string) => 'unused-no-local-verification';
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => '/tmp/tofu.zip',
    extractZip: async (_zipPath: string) => '/tmp/tofu-extracted',
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => '/tmp/tofu-cached',
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
