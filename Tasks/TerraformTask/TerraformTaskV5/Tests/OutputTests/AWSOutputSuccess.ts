import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AWSOutputSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAWS', 'AWS');

process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'test-access-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'test-secret-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_REGION'] = 'us-east-1';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform output -json": {
            "code": 0,
            "stdout": "{ \"test_output\": { \"value\": \"hello\" } }"
        }
    }
};

tr.setAnswers(a);
tr.run();
