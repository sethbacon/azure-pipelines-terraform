import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './StateMvSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'state');
tr.setInput('stateSubCommand', 'mv');
tr.setInput('stateAddress', 'aws_instance.old aws_instance.new');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform state mv aws_instance.old aws_instance.new": {
            "code": 0,
            "stdout": "Move \"aws_instance.old\" to \"aws_instance.new\"\nSuccessfully moved 1 object(s)."
        }
    }
};

tr.setAnswers(a);
tr.run();
