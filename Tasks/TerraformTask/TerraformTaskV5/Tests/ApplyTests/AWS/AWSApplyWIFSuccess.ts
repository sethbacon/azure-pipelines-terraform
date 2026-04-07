import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AWSApplyWIFSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'apply');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAWS', 'AWS');
tr.setInput('environmentAuthSchemeAWS', 'WorkloadIdentityFederation');
tr.setInput('awsRoleArn', 'arn:aws:iam::123456789012:role/MyTerraformRole');
tr.setInput('awsRegion', 'us-east-1');
tr.setInput('awsSessionName', 'AzureDevOps-Terraform');

tr.registerMock('./id-token-generator', {
    generateIdToken: (serviceConnectionId: string) => {
        return Promise.resolve('mock-oidc-token-12345');
    }
});

tr.registerMock('uuid', { v4: () => 'test-uuid-1234' });

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform providers": {
            "code": 0,
            "stdout": "provider aws"
        },
        "terraform apply -auto-approve": {
            "code": 0,
            "stdout": "Apply complete!"
        }
    }
};

tr.setAnswers(a);
tr.run();
