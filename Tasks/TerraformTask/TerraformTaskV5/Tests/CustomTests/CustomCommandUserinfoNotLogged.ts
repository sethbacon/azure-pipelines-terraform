import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// #1105 class row: customCommand is a free-form argument string that can carry
// a URL with userinfo. The credential must be registered with the masker
// BEFORE any line that could show it is written -- task-lib's own debug line
// at read time, the per-argument debug lines, the [command] echo -- so the
// agent masks every one of them at runtime.
let tp = path.join(__dirname, './CustomCommandUserinfoNotLoggedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'custom');
tr.setInput('customCommand', 'init -backend-config=address=https://svc:CUSTOM-TOKEN-xyz@state.example.com/tf');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('outputTo', 'console');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAWS', 'AWS');

process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'DummyUsername';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'DummyPassword';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init -backend-config=address=https://svc:CUSTOM-TOKEN-xyz@state.example.com/tf": {
            "code": 0,
            "stdout": "Initialized"
        }
    }
};

tr.setAnswers(a);
tr.run();
