import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// This scenario mocks crypto.randomUUID to a fixed value, which makes the
// credential temp-file paths deterministic across runs. writeSecretFile now
// refuses to overwrite an existing file (O_EXCL, #484), so point
// Agent.TempDirectory at a scrubbed per-scenario directory -- matching real
// agents, where Agent.TempDirectory is always set and job-purged.
const wifTempDir = path.join(os.tmpdir(), 'tf-wif-GCPPlanWIFSuccess');
fs.rmSync(wifTempDir, { recursive: true, force: true });
fs.mkdirSync(wifTempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = wifTempDir;

let tp = path.join(__dirname, './GCPPlanWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'gcp');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameGCP', 'GCP');
tr.setInput('environmentAuthSchemeGCP', 'WorkloadIdentityFederation');
tr.setInput('gcpProjectNumber', '123456789012');
tr.setInput('gcpWorkloadIdentityPoolId', 'my-wif-pool');
tr.setInput('gcpWorkloadIdentityProviderId', 'my-oidc-provider');
tr.setInput('gcpServiceAccountEmail', 'terraform@my-project.iam.gserviceaccount.com');
tr.setInput('commandOptions', '');

var mock = {
    "generateIdToken": function(_serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); }
};

tr.registerMock('./id-token-generator', mock);
tr.registerMock('crypto', { randomUUID: () => 'test-uuid-1234' });

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform providers": {
            "code": 0,
            "stdout": "provider google"
        },
        "terraform plan -detailed-exitcode": {
            "code": 0,
            "stdout": "Executed successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
