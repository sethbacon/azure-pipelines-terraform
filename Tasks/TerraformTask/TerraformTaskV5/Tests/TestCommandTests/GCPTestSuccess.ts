import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './GCPTestSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'gcp');
tr.setInput('command', 'test');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameGCP', 'GCP');

process.env['ENDPOINT_AUTH_SCHEME_GCP'] = 'Jwt';
process.env['ENDPOINT_DATA_GCP_PROJECT'] = 'DummyProject';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_ISSUER'] = 'DummyClientEmail';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_AUDIENCE'] = 'https://oauth2.googleapis.com/token';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_PRIVATEKEY'] = 'DummyPrivateKey';
process.env['ENDPOINT_AUTH_PARAMETER_GCP_SCOPE'] = 'https://www.googleapis.com/auth/cloud-platform';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform test": {
            "code": 0,
            "stdout": "Success! 0 passed, 0 failed."
        }
    }
};

tr.setAnswers(a);
tr.run();
