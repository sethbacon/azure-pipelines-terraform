import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Sibling of azure-pipelines-packer#330, found by surveying the scanner's
// EXEMPT-OPERATOR-DECLARED rule rather than by the audit.
//
// registryUrl's OWN host is never egress-authorized -- the guard is applied only to
// the download_url the registry returns. Version resolution runs BEFORE any
// download_url exists, so it reaches the network completely unguarded. registryUrl
// supports basic-auth userinfo, so the operator's registry credential is sent to
// whatever address they named.
//
// fetchJson throws for every URL, so a task that skips the guard still fails; the
// assertion in L0.ts reads the rendered refusal message, which is what distinguishes
// "refused" from "attempted and happened to error".
const tp = path.join(__dirname, 'RegistryLatestUrlPrivateHostRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('terraformVersion', 'latest');
tr.setInput('downloadSource', 'registry');
tr.setInput('registryUrl', 'https://169.254.169.254/artifactory');
tr.setInput('registryMirrorName', 'terraform');

tr.registerMock('os', { type: () => 'Linux', arch: () => 'x64' });

tr.registerMock('./http-client', {
    fetchJson: async (url: string) => { throw new Error('Refused host must not be fetched: ' + url); },
    fetchText: async (url: string) => { throw new Error('Refused host must not be fetched: ' + url); },
    fetchTextAllow404: async (url: string) => { throw new Error('Refused host must not be fetched: ' + url); }
});

tr.registerMock('undici', { ProxyAgent: class { } });
tr.registerMock('azure-pipelines-tool-lib/tool', {
    findLocalTool: (_toolName: string, _version: string) => null,
    cleanVersion: (version: string) => version,
    prependPath: (_toolPath: string) => { }
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
