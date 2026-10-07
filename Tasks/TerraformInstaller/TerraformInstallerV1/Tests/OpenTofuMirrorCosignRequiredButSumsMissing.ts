import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// An OpenTofu mirror that does not publish a SHA256SUMS, with requireChecksum=false so
// the missing checksum alone is tolerated. requireCosignVerification keeps its
// fail-closed default (true), so there is nothing to authenticate the archive with and
// the install must fail naming cosign -- not GPG: requireGpgSignature is left at its
// default (true) and has no role for OpenTofu, so a GPG-worded error would mean the
// Terraform toggle leaked into the OpenTofu path.
const tp = path.join(__dirname, 'OpenTofuMirrorCosignRequiredButSumsMissingL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://artifacts.example.com/opentofu');
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
        throw new Error('fetchJson should not be called for a pinned mirror download. Called with: ' + url);
    },
    // A genuine 404: the mirror publishes no SHA256SUMS.
    fetchTextAllow404: async (_url: string) => null,
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        isHostAllowed(new URL(url).hostname);
    },
    DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => {
        throw new Error('verifyCosignSignature must not be reached: there is no SHA256SUMS to verify.');
    }
});

tr.registerMock('fs', {
    chmodSync: (_path: string, _mode: string) => { },
    createReadStream: (_path: string) => require('stream').Readable.from(Buffer.from('fake-zip-content')),
    unlinkSync: (_path: string) => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => {
        const hash: any = new (require('stream').Writable)({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
        hash.digest = (_encoding: string) => 'unused';
        return hash;
    }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => '/tmp/tofu.zip',
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip must not be reached when required signing material is withheld');
    },
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir must not be reached when required signing material is withheld');
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
