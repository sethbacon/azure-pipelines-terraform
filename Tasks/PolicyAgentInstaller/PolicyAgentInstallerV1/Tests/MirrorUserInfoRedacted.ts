import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #586: an operator mirror URL that embeds basic-auth userinfo. The real download
// must still carry the credential (the mock asserts the download URL keeps it), but
// the policyAgentDownloadedFrom pipeline variable must be stored WITHOUT the
// userinfo, and the credential must be registered as a secret. The subject module
// (policy-agent-installer) is not mocked — its real masking/stripping wiring runs.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://user:s3cr3t@mirror.example.com');
tr.setInput('requireChecksum', 'false');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Mirror path should not call fetchJson: ' + url); },
    fetchTextAllow404: async () => null // no .sha256; requireChecksum=false -> warn + proceed
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    chmodSync: () => { },
    readFileSync: () => Buffer.from('fake-binary'),
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => 'unused' }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async (url: string) => {
        // The actual download must retain the credential to reach the mirror.
        if (!url.includes('user:s3cr3t@mirror.example.com')) {
            throw new Error('mirror download URL must retain the basic-auth userinfo; got: ' + url);
        }
        return '/tmp/opa-download';
    },
    extractZip: async () => { throw new Error('extractZip should not be called for OPA'); },
    cacheDir: async () => '/tmp/opa-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = { find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] } };
tr.setAnswers(a);
tr.run();
