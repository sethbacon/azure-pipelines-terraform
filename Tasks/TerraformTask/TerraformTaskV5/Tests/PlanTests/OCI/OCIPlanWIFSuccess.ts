import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './OCIPlanWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameOCI', 'OCI');
tr.setInput('environmentAuthSchemeOCI', 'WorkloadIdentityFederation');
tr.setInput('ociWifTenancyOcid', 'ocid1.tenancy.oc1..dummy');
tr.setInput('ociWifRegion', 'us-ashburn-1');
tr.setInput('ociWifIdentityDomainUrl', 'https://idcs-dummy.identity.oraclecloud.com');
tr.setInput('ociWifClientId', 'dummy-client-id');
tr.setInput('commandOptions', '');

tr.registerMock('./id-token-generator', {
    generateIdToken: function(serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); }
});

tr.registerMock('./oci-token-exchange', {
    exchangeOidcForUpst: function(oidcToken: string, identityDomainUrl: string, clientId: string, publicKeyPem: string) {
        return Promise.resolve('mock-upst-token-67890');
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
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
