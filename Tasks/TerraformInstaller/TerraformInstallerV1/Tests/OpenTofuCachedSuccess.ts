import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, 'OpenTofuCachedSuccessL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('binary', 'tofu');
tr.setInput('terraformVersion', '1.11.6');

tr.registerMock('os', {
    type: () => 'Windows_NT',
    arch: () => 'x64'
});

// http-client should NOT be called when tool is cached
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => {
        throw new Error('fetchJson should not be called when tool is cached. Called with: ' + url);
    },
    fetchText: async (url: string) => {
        throw new Error('fetchText should not be called when tool is cached. Called with: ' + url);
    },
    fetchBuffer: async (url: string) => {
        throw new Error('fetchBuffer should not be called when tool is cached. Called with: ' + url);
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });
tr.registerMock('undici', { ProxyAgent: class { } });

tr.registerMock('./gpg-verifier', {
    verifyGpgSignature: async () => { }
});

tr.registerMock('./cosign-verifier', {
    verifyCosignSignature: async () => { }
});

tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => '/tmp/tofu-cached',
    downloadTool: async (_url: string, _fileName: string) => {
        throw new Error('downloadTool should not be called when tool is cached');
    },
    extractZip: async (_zipPath: string) => {
        throw new Error('extractZip should not be called when tool is cached');
    },
    cacheDir: async (_srcPath: string, _tool: string, _version: string) => {
        throw new Error('cacheDir should not be called when tool is cached');
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
