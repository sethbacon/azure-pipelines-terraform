import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('policyAgent', 'opa');
tr.setInput('version', '1.17.1');
tr.setInput('downloadSource', 'official');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('fetchJson should not be called when tool is cached: ' + url); },
    fetchTextAllow404: async (url: string) => { throw new Error('fetchTextAllow404 should not be called when tool is cached: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./gpg-verifier', { verifyGpgSignature: async () => { } });

// No stored integrity marker exists (e.g. cached by an installer version that
// predates this check, or cached with checksum verification disabled): the
// cache-hit re-verification must degrade to the pre-existing trust-the-cache
// behavior rather than fail the install.
tr.registerMock('fs', {
    existsSync: () => false,
    readFileSync: () => { throw new Error('readFileSync should not be called when no integrity marker exists'); },
    writeFileSync: () => { throw new Error('writeFileSync should not be called on a cache hit'); },
    chmodSync: () => { },
    mkdirSync: () => undefined,
    copyFileSync: () => { }
});

tr.registerMock('crypto', { randomUUID: () => 'test-uuid' });

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => '/tmp/opa-cached',
    downloadTool: async () => { throw new Error('downloadTool should not be called when tool is cached'); },
    extractZip: async () => { throw new Error('extractZip should not be called when tool is cached'); },
    cacheDir: async () => { throw new Error('cacheDir should not be called when tool is cached'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {
    find: { '/tmp/opa-cached': ['/tmp/opa-cached/opa'] }
};
tr.setAnswers(a);
tr.run();
