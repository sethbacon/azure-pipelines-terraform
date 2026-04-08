import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './OCIApplySuccessAdditionalArgsWithAutoApproveL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameOCI', 'OCI');
tr.setInput('commandOptions', '-auto-approve -var abc=123');

process.env['ENDPOINT_DATA_OCI_TENANCY'] = 'dummy-tenancy-ocid';
process.env['ENDPOINT_DATA_OCI_USER'] = 'dummy-user-ocid';
process.env['ENDPOINT_DATA_OCI_REGION'] = 'us-ashburn-1';
process.env['ENDPOINT_DATA_OCI_FINGERPRINT'] = 'aa:bb:cc:dd:ee';
process.env['ENDPOINT_DATA_OCI_PRIVATEKEY'] = '-----BEGIN PRIVATE KEY----- dummykeydata -----END PRIVATE KEY-----';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform providers": {
            "code": 0,
            "stdout": "Executed successfully"
        },
        "terraform apply -auto-approve -var abc=123": {
            "code": 0,
            "stdout": "Executed Successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
