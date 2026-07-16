import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');
import { TEST_GCP_PRIVATE_KEY_SPACES } from '../test-gcp-fixtures';

// The output command writes its JSON file under Agent.TempDirectory (#492);
// point it at a scrubbed per-scenario directory so runs don't accumulate
// files in the real temp directory.
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-gcp-success-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

let tp = path.join(__dirname, './GCPOutputSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'gcp');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameGCP', 'GCP');

process.env['ENDPOINT_AUTH_SCHEME_GCP'] = 'Jwt';
process.env['ENDPOINT_DATA_GCP_PROJECT'] = 'test-project';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_ISSUER'] = 'test@test.iam.gserviceaccount.com';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_AUDIENCE'] = 'https://oauth2.googleapis.com/token';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_PRIVATEKEY'] = TEST_GCP_PRIVATE_KEY_SPACES;
process.env['ENDPOINT_AUTH_PARAMETER_GCP_SCOPE'] = 'https://www.googleapis.com/auth/cloud-platform';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform output -json": {
            "code": 0,
            "stdout": "{ \"test_output\": { \"value\": \"hello\" } }"
        }
    }
};

tr.setAnswers(a);
tr.run();
