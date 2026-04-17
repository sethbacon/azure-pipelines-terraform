import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { TEST_OCI_PRIVATE_KEY_SPACES } from '../test-oci-fixtures';

let tp = path.join(__dirname, './OCIShowConsoleSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('outputFormat', 'default');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameOCI', 'OCI');

process.env['ENDPOINT_DATA_OCI_TENANCY'] = 'ocid1.tenancy.oc1..dummy';
process.env['ENDPOINT_DATA_OCI_USER'] = 'ocid1.user.oc1..dummy';
process.env['ENDPOINT_DATA_OCI_REGION'] = 'us-ashburn-1';
process.env['ENDPOINT_DATA_OCI_FINGERPRINT'] = 'aa:bb:cc:dd:ee:ff';
process.env['ENDPOINT_DATA_OCI_PRIVATEKEY'] = TEST_OCI_PRIVATE_KEY_SPACES;

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform show": {
            "code": 0,
            "stdout": "No changes. Infrastructure is up-to-date."
        }
    }
};

tr.setAnswers(a);
tr.run();
