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
const wifTempDir = path.join(os.tmpdir(), 'tf-wif-GCPInitSuccessAdditionalArgs');
fs.rmSync(wifTempDir, { recursive: true, force: true });
fs.mkdirSync(wifTempDir, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = wifTempDir;
import { TEST_GCP_PRIVATE_KEY_SPACES } from '../../test-gcp-fixtures';

let tp = path.join(__dirname, './GCPInitSuccessAdditionalArgsL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'gcp');
tr.setInput('command', 'init');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '-no-color');

tr.setInput('backendServiceGCP', 'GCP');
tr.setInput('backendGCPBucketName', 'DummyBucket');
tr.setInput('backendGCPPrefix', 'DummyPrefix');

process.env['ENDPOINT_AUTH_SCHEME_GCP'] = 'Jwt';
process.env['ENDPOINT_DATA_GCP_PROJECT'] = 'DummyProject';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_ISSUER'] = 'Dummyissuer';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_AUDIENCE'] = 'https://oauth2.googleapis.com/token';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_PRIVATEKEY'] = TEST_GCP_PRIVATE_KEY_SPACES;
process.env['ENDPOINT_AUTH_PARAMETER_GCP_SCOPE'] = 'DummyScope';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init -no-color -backend-config=bucket=DummyBucket -backend-config=prefix=DummyPrefix": {
            "code": 0,
            "stdout": "Executed Successfully"
        }
    }
}

tr.registerMock('crypto', { randomUUID: () => '123', createPrivateKey: require('crypto').createPrivateKey });
tr.setAnswers(a);

tr.run();