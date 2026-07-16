import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');
// The operator explicitly opted out of checksum verification: no remote
// re-verification attempt (and no repeated-download cost) on an unmarked cache
// hit — the documented escape hatch for offline/opted-out configurations.
tr.setInput('requireChecksum', 'false');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called when re-verification is skipped: ' + url); },
    fetchTextAllow404: async (url: string) => { throw new Error('fetchTextAllow404 should not be called when re-verification is skipped: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

tr.registerMock('fs', {
    existsSync: (_p: string) => false, // no stored integrity marker
    readFileSync: (_p: string, _enc?: string) => {
        throw new Error('readFileSync should not be called when re-verification is skipped');
    },
    writeFileSync: () => { throw new Error('writeFileSync should not be called when re-verification is skipped'); },
    chmodSync: () => { },
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async (url: string) => {
        console.log('DOWNLOAD_ATTEMPTED:' + url);
        throw new Error('downloadTool should not be called when re-verification is skipped');
    },
    extractZip: async () => { throw new Error('extractZip should not be called when re-verification is skipped'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called on a cache hit'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
