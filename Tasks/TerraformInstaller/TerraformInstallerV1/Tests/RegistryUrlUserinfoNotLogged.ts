import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1105 finding 1 (class): registryUrl may carry basic-auth userinfo here (a
// supported pattern), and task-lib's getInput() debug-logs every input raw at
// READ time -- before anything can mask it. The read goes through the package's
// silent reader instead; this run proceeds to the (throwing) client mock, so the
// task fails, and the assertion is only that the credential never reaches a
// log-visible line and that the redacted debug line is what gets written.
const tp = path.join(__dirname, 'RegistryUrlUserinfoNotLoggedL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', '1.9.8');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://svc:PAT-s3cr3t-value@registry.example.com');
tr.setInput('registryMirrorName', 'terraform');

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
