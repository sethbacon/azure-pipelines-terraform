import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './OCIPlanWIFFailInvalidDomainUrlL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameOCI', 'OCI');
tr.setInput('environmentAuthSchemeOCI', 'WorkloadIdentityFederation');
tr.setInput('ociWifTenancyOcid', 'ocid1.tenancy.oc1..dummy');
tr.setInput('ociWifRegion', 'us-ashburn-1');
// Non-HTTPS, non-OCI host: the real token exchange must reject this before
// the federated OIDC JWT is sent anywhere.
tr.setInput('ociWifIdentityDomainUrl', 'http://insecure-url.example.com');
tr.setInput('ociWifClientId', 'dummy-client-id');
tr.setInput('commandOptions', '');

// Mock only the OIDC token source so the flow reaches the REAL token exchange,
// where the identity-domain URL validation lives.
tr.registerMock('./id-token-generator', {
    generateIdToken: function (_serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); }
});

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
        "terraform plan -detailed-exitcode": {
            "code": 0,
            "stdout": "Executed successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
