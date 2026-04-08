import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AWSInitWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'init');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');

tr.setInput('backendAuthSchemeAWS', 'WorkloadIdentityFederation');
tr.setInput('backendServiceAWS', 'AWS');
tr.setInput('backendAWSBucketName', 'DummyBucket');
tr.setInput('backendAWSKey', 'DummyKey');
tr.setInput('backendAWSRoleArn', 'arn:aws:iam::123456789012:role/MyBackendRole');
tr.setInput('backendAWSRegion', 'us-east-1');
tr.setInput('backendAWSSessionName', 'AzureDevOps-Terraform-Backend');

var mock = {
    "generateIdToken": function(serviceConnectionId: string) { return Promise.resolve('mock-oidc-token-12345'); }
};

tr.registerMock('./id-token-generator', mock);
tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init -backend-config=bucket=DummyBucket -backend-config=key=DummyKey": {
            "code": 0,
            "stdout": "Executed Successfully"
        }
    }
}

tr.setAnswers(a);
tr.run();
