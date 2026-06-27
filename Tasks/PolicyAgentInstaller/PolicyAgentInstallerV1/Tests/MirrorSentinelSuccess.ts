import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'sentinel');
tr.setInput('version', '0.40.0');
tr.setInput('downloadSource', 'mirror');
tr.setInput('mirrorBaseUrl', 'https://mirror.example.com');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

const EXPECTED_SHA256 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Mirror path should not call fetchJson: ' + url); },
    fetchText: async (url: string) => {
        if (url === 'https://mirror.example.com/0.40.0/sentinel_0.40.0_SHA256SUMS') {
            return `${EXPECTED_SHA256}  sentinel_0.40.0_linux_amd64.zip\n`;
        }
        throw new Error('Unexpected fetchText URL: ' + url);
    }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { throw new Error('mirror must not use GPG'); } });

tr.registerMock('fs', {
    chmodSync: () => { },
    readFileSync: () => Buffer.from('fake-zip')
});

tr.registerMock('crypto', {
    randomUUID: () => 'test-uuid',
    createHash: () => ({ update: () => ({ digest: () => EXPECTED_SHA256 }) })
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async () => '/tmp/sentinel.zip',
    extractZip: async () => '/tmp/sentinel-extracted',
    cacheDir: async () => '/tmp/sentinel-cached',
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/sentinel-cached': ['/tmp/sentinel-cached/sentinel'] }
};
tr.setAnswers(a);
tr.run();
