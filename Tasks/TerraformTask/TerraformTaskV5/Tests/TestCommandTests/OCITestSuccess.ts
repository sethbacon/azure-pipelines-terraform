import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './OCITestSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'test');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameOCI', 'OCI');

process.env['ENDPOINT_DATA_OCI_TENANCY'] = 'DummyTenancy';
process.env['ENDPOINT_DATA_OCI_USER'] = 'DummyUser';
process.env['ENDPOINT_DATA_OCI_REGION'] = 'us-ashburn-1';
process.env['ENDPOINT_DATA_OCI_FINGERPRINT'] = 'DummyFingerprint';
process.env['ENDPOINT_DATA_OCI_PRIVATEKEY'] = '-----BEGIN PRIVATE KEY----- DummyKey -----END PRIVATE KEY-----';

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
