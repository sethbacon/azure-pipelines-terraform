import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #586: an operator mirror URL that embeds basic-auth userinfo. The real download
// must still carry the credential (the mock asserts the download URL keeps it), but
// the terraformDownloadedFrom pipeline variable must be stored WITHOUT the userinfo,
// and the credential must be registered as a secret. The subject module
// (terraform-installer) is NOT mocked — its real masking/stripping wiring runs.
const tp = path.join(__dirname, 'MirrorUserInfoRedactedL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://user:s3cr3t@artifacts.example.com/hashicorp/terraform');
tr.setInput('requireChecksum', 'false');
tr.setInput('requireGpgSignature', 'false');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64',
    tmpdir: () => '/tmp'
});

// dns: the mirror host is a fake test domain; mock it to a public (non-private/
// link-local) address so the #799 initial-host check passes without a real
// network lookup, reaching the downloadToFile call this test exercises.
tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called for mirror download. Called with: ' + url);
    },
    fetchTextAllow404: async () => null, // no SHA256SUMS; requireChecksum=false -> warn + proceed
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        // The actual download must retain the credential to reach the mirror.
        if (!url.includes('user:s3cr3t@artifacts.example.com')) {
            throw new Error('mirror download URL must retain the basic-auth userinfo; got: ' + url);
        }
        isHostAllowed(new URL(url).hostname);
    },
    DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });
tr.registerMock('./cosign-verifier', { verifyCosignSignature: async () => { } });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
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
