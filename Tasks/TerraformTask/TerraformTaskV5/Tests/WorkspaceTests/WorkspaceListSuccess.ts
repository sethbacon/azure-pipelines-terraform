import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, 'WorkspaceListSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'workspace');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('workspaceSubCommand', 'list');
tr.setInput('commandOptions', '');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform workspace list": {
            "code": 0,
            "stdout": "* default\n  production\n  staging"
        }
    }
};

tr.setAnswers(a);
tr.run();
