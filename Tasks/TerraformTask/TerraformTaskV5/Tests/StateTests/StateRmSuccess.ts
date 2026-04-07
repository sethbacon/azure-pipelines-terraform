import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './StateRmSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'state');
tr.setInput('stateSubCommand', 'rm');
tr.setInput('stateAddress', 'aws_instance.example');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform state rm aws_instance.example": {
            "code": 0,
            "stdout": "Removed aws_instance.example\nSuccessfully removed 1 resource instance(s)."
        }
    }
};

tr.setAnswers(a);
tr.run();
