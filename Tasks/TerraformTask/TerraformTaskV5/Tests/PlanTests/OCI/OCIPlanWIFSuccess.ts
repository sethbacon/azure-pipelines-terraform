import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { adoPackageMock } from '../../adoPackageMock';

let tp = path.join(__dirname, './OCIPlanWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'plan');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameOCI', 'OCI');
tr.setInput('environmentAuthSchemeOCI', 'WorkloadIdentityFederation');
tr.setInput('ociWifTenancyOcid', 'ocid1.tenancy.oc1..dummy');
tr.setInput('ociWifRegion', 'us-ashburn-1');
tr.setInput('ociWifIdentityDomainUrl', 'https://idcs-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.identity.oraclecloud.com');
tr.setInput('ociWifClientId', 'dummy-client-id');
tr.setInput('commandOptions', '');

tr.registerMock('@4cloudguru/pipeline-task-ado', adoPackageMock({
    generateIdToken: function (_serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); }
}));

tr.registerMock('./oci-token-exchange', {
    // validateIdentityDomainUrl is now called directly by handleProviderWIF
    // (#1029, before generateIdToken), not only internally by
    // exchangeOidcForUpst -- this mock must implement it too, or the real
    // handler's call resolves to undefined under this replacement module.
    validateIdentityDomainUrl: function (identityDomainUrl: string) {
        return new URL(identityDomainUrl);
    },
    exchangeOidcForUpst: function (_oidcToken: string, _identityDomainUrl: string, _clientId: string, _publicKeyPem: string) {
        return Promise.resolve('mock-upst-token-67890');
    }
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
