import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');

let tp = path.join(__dirname, './GCPInitWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'gcp');
tr.setInput('command', 'init');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');

tr.setInput('backendAuthSchemeGCP', 'WorkloadIdentityFederation');
tr.setInput('backendServiceGCP', 'GCP');
tr.setInput('backendGCPBucketName', 'DummyBucket');
tr.setInput('backendGCPPrefix', 'DummyPrefix');
tr.setInput('backendGCPProjectNumber', '123456789012');
tr.setInput('backendGCPWorkloadIdentityPoolId', 'my-wif-pool');
tr.setInput('backendGCPWorkloadIdentityProviderId', 'my-oidc-provider');
tr.setInput('backendGCPServiceAccountEmail', 'terraform@my-project.iam.gserviceaccount.com');

var mock = {
    "generateIdToken": function (_serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); }
};

tr.registerMock('./id-token-generator', mock);

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init -backend-config=bucket=DummyBucket -backend-config=prefix=DummyPrefix": {
            "code": 0,
            "stdout": "Executed Successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
