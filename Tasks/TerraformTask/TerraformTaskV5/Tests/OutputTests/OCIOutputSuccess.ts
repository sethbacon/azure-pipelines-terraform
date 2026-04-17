import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { TEST_OCI_PRIVATE_KEY_SPACES } from '../test-oci-fixtures';

let tp = path.join(__dirname, './OCIOutputSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'output');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameOCI', 'OCI');

process.env['ENDPOINT_DATA_OCI_TENANCY'] = 'ocid1.tenancy.oc1..dummy';
process.env['ENDPOINT_DATA_OCI_USER'] = 'ocid1.user.oc1..dummy';
process.env['ENDPOINT_DATA_OCI_REGION'] = 'us-ashburn-1';
process.env['ENDPOINT_DATA_OCI_FINGERPRINT'] = 'aa:bb:cc:dd:ee:ff';
process.env['ENDPOINT_DATA_OCI_PRIVATEKEY'] = TEST_OCI_PRIVATE_KEY_SPACES;

tr.registerMock('uuid', { v4: () => '123' });

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform output -json": {
            "code": 0,
            "stdout": "{\"instance_ip\":{\"value\":\"10.0.0.1\",\"type\":\"string\"}}"
        }
    }
};

tr.setAnswers(a);
tr.run();
