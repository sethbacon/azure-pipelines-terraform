import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Specific version should not call fetchJson: ' + url); },
    fetchText: async (url: string) => {
        if (url.endsWith('.sha256')) {
            return `${EXPECTED_SHA256}  opa_linux_amd64\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
// Mock gpg-verifier so openpgp is never loaded (it needs the real crypto module).
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    chmodSync: () => { },
    readFileSync: () => Buffer.from('fake-binary'),
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => EXPECTED_SHA256 }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async () => '/tmp/opa-download',
    extractZip: async () => { throw new Error('OPA is a raw binary; extractZip should not be called'); },
    cacheDir: async () => '/tmp/opa-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
