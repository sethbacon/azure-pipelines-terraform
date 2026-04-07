import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './GCPShowConsoleSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'gcp');
tr.setInput('command', 'show');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', '');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameGCP', 'GCP');

process.env['ENDPOINT_AUTH_SCHEME_GCP'] = 'Jwt';
process.env['ENDPOINT_DATA_GCP_PROJECT'] = 'test-project';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_ISSUER'] = 'test@test.iam.gserviceaccount.com';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_AUDIENCE'] = 'https://oauth2.googleapis.com/token';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_PRIVATEKEY'] = 'test-private-key';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_SCOPE'] = 'https://www.googleapis.com/auth/cloud-platform';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform show": {
            "code": 0,
            "stdout": "Terraform show output"
        }
    }
};

tr.setAnswers(a);
tr.run();
