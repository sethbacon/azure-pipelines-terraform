import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #586: an operator mirror URL that embeds basic-auth userinfo. The real download
// must still carry the credential (the mock asserts the download URL keeps it), but
// the terraformDocsDownloadedFrom pipeline variable must be stored WITHOUT the
// userinfo, and the credential must be registered as a secret. The subject module
// (terraform-docs-installer) is not mocked — its real masking/stripping wiring runs.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://user:s3cr3t@artifacts.example.com/terraform-docs');
tr.setInput('requireChecksum', 'false');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

// dns: the mirror host is a fake test domain; mock it to a public (non-private/
// link-local) address so the #799 initial-host check passes without a real
// network lookup.
tr.registerMock('dns', {
    promises: {
        lookup: async (_host: string, _opts: any) => [{ address: '203.0.113.10', family: 4 }]
    }
});

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Mirror path should not fetch json: ' + url); },
    fetchTextAllow404: async () => null, // no .sha256sum; requireChecksum=false -> warn + proceed
    downloadToFile: async (url: string, _destPath: string, _timeoutMs: number, isHostAllowed: (hostname: string) => void) => {
        // The actual download must retain the credential to reach the mirror.
        if (!url.includes('user:s3cr3t@artifacts.example.com')) {
            throw new Error('mirror download URL must retain the basic-auth userinfo; got: ' + url);
        }
        isHostAllowed(new URL(url).hostname);
    },
    DOWNLOAD_TIMEOUT_MS: 30000
});

tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('fs', {
    chmodSync: () => { },
    readFileSync: () => Buffer.from('fake-archive')
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => 'unused' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async () => {
        throw new Error('downloadTool should not be called for a mirror download -- downloadToFile must be used (#799)');
    },
    extractTar: async () => '/tmp/terraform-docs-extracted',
    extractZip: async () => { throw new Error('extractZip should not be called on Linux'); },
    cacheDir: async () => '/tmp/terraform-docs-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/terraform-docs-cached': ['/tmp/terraform-docs-cached/terraform-docs'] }
};
tr.setAnswers(a);
tr.run();
