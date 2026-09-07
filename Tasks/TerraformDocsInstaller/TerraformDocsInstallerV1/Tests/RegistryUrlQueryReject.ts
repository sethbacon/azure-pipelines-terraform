import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1110 finding 2 (class fix): registryUrl / mirrorBaseUrl are bases a fixed path
// is concatenated onto, so a query string or fragment in them would silently
// retarget the request while the host allowlist sees nothing. Refused at the read,
// before any request; the http-client mock below throws so a missing guard fails
// for a different, visible reason rather than passing.
const tp = path.join(__dirname, 'RunInstaller.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('version', '0.24.0');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://registry.example.com/?x=');
tr.setInput('registryMirrorName', 'terraform-docs');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64', tmpdir: () => '/tmp' });
tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('must not fetch with a query/fragment-carrying base: ' + url); },
    fetchText: async (url: string) => { throw new Error('must not fetch with a query/fragment-carrying base: ' + url); }
});
tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: () => null,
    downloadTool: async () => { throw new Error('must not download with a query/fragment-carrying base'); },
    extractZip: async () => { throw new Error('must not extract'); },
    extractTar: async () => { throw new Error('must not extract'); },
    cacheDir: async () => { throw new Error('must not cache'); },
    cleanVersion: (v: string) => v,
    prependPath: () => { }
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
