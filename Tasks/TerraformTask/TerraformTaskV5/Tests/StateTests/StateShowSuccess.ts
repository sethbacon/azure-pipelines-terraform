import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './StateShowSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'state');
tr.setInput('stateSubCommand', 'show');
tr.setInput('stateAddress', 'aws_instance.example');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform state show aws_instance.example": {
            "code": 0,
            "stdout": "resource \"aws_instance\" \"example\" { ami = \"abc-123\" }"
        }
    }
};

tr.setAnswers(a);
tr.run();
