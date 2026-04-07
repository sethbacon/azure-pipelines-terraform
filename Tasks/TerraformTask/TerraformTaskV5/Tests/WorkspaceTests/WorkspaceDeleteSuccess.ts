import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './WorkspaceDeleteSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'workspace');
tr.setInput('workspaceSubCommand', 'delete');
tr.setInput('workspaceName', 'staging');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform workspace delete staging": {
            "code": 0,
            "stdout": "Deleted workspace \"staging\"!"
        }
    }
};

tr.setAnswers(a);
tr.run();
