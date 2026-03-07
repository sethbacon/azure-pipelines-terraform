import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, 'StatePushWarningL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'state');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('stateSubCommand', 'push');
tr.setInput('stateAddress', 'local.tfstate');
tr.setInput('commandOptions', '');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform state push local.tfstate": {
            "code": 0,
            "stdout": "Pushed state successfully."
        }
    }
};

tr.setAnswers(a);
tr.run();
