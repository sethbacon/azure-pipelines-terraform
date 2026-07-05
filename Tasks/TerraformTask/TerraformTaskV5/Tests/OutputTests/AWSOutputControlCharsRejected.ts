import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// A compromised module/provider fully controls terraform output -json's
// content. An output value containing a newline could forge additional ADO
// logging commands in the console output that consumes this variable
// downstream -- setOutputVariables must reject it rather than pass it
// through to tasks.setVariable() unsanitized.
let tp = path.join(__dirname, './AWSOutputControlCharsRejectedL0.js');
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
            "stdout": "{ \"safe_output\": { \"value\": \"hello\" }, \"malicious_output\": { \"value\": \"ami-0123\\nrm -rf /\" } }"
        }
    }
};

tr.setAnswers(a);
tr.run();
