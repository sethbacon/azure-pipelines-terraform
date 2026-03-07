import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, 'StateListSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'state');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('stateSubCommand', 'list');
tr.setInput('commandOptions', '');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform state list": {
            "code": 0,
            "stdout": "azurerm_resource_group.rg\nazurerm_storage_account.sa"
        }
    }
};

tr.setAnswers(a);
tr.run();
