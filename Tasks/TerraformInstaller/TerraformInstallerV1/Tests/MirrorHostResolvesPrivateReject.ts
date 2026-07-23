import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #799: the mirror host is an ordinary-looking DNS name -- not a literal private
// IP, so isPrivateOrLinkLocalHost alone would miss it -- but it resolves (via the
// mocked dns module below) to the cloud metadata address 169.254.169.254. The
// task must still reject before downloading, proving the mirror path's initial-
// host check uses resolvesToPrivateOrLinkLocalAddress (the DNS-resolution
// variant), not just a literal-IP check (mirrors the registry path's #769 test).
const tp = path.join(__dirname, 'MirrorHostResolvesPrivateRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://mirror.example.com/hashicorp/terraform');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64',
    tmpdir: () => '/tmp'
});

// dns: mirror.example.com is not a literal private IP but resolves to the cloud
// metadata address -- the resolvesToPrivateOrLinkLocalAddress check must catch it.
tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '169.254.169.254', family: 4 }]
    }
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
    },
    downloadToFile: async (_url: string, _destPath: string, _timeoutMs: number, _isHostAllowed: (hostname: string) => void) => {
        throw new Error('downloadToFile should not be reached for a mirror host that resolves to a private address');
    },
    DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid-1234',
    createHash: (_algorithm: string) => ({
        update: (_data: any) => ({
            digest: (_encoding: string) => 'should-not-be-reached'
        })
    })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be reached for a mirror host that resolves to a private address');
    },
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
