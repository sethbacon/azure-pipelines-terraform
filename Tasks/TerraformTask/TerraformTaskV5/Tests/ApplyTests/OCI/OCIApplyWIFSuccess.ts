import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import { adoPackageMock } from '../../adoPackageMock';

let tp = path.join(__dirname, './OCIApplyWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'oci');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameOCI', 'OCI');
tr.setInput('environmentAuthSchemeOCI', 'WorkloadIdentityFederation');
tr.setInput('ociWifTenancyOcid', 'ocid1.tenancy.oc1..dummy');
tr.setInput('ociWifRegion', 'us-ashburn-1');
tr.setInput('ociWifIdentityDomainUrl', 'https://idcs-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.identity.oraclecloud.com');
tr.setInput('ociWifClientId', 'dummy-client-id');
tr.setInput('commandOptions', '');

// The token exchange moved into the shared package (#1074), so both hops are
// overridden on the one module mock now. adoPackageMock spreads the real
// package, so everything not named here stays live.
//
// validateIdentityDomainUrl is called directly by handleProviderWIF (#1029,
// before generateIdToken), not only internally by exchangeOidcForUpst -- it
// must be overridden too, or the handler's call resolves to undefined.
tr.registerMock('@4cloudguru/pipeline-task-ado', adoPackageMock({
    generateIdToken: function (_serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); },
    validateIdentityDomainUrl: function (identityDomainUrl: string) {
        return new URL(identityDomainUrl);
    },
    exchangeOidcForUpst: function (_oidcToken: string, _identityDomainUrl: string, _clientId: string, _publicKeyPem: string) {
        return Promise.resolve('mock-upst-token-67890');
    }
}));

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
        "terraform apply -auto-approve": {
            "code": 0,
            "stdout": "Executed successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
