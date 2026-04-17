import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { TEST_OCI_PRIVATE_KEY_SPACES } from '../../test-oci-fixtures';

let tp = path.join(__dirname, './OCIDestroySuccessNoAdditionalArgsL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'destroy');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameOCI', 'OCI');
tr.setInput('commandOptions', '');

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
        "terraform providers": {
            "code": 0,
            "stdout": "provider oci"
        },
        "terraform destroy -auto-approve": {
            "code": 0,
            "stdout": "Executed successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
