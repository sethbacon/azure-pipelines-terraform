import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './HCPInitSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'init');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('backendType', 'hcp');
tr.setInput('backendHCPToken', 'dummy-hcp-token');
tr.setInput('backendHCPOrganization', 'my-org');
tr.setInput('backendHCPWorkspace', 'my-workspace');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init": {
            "code": 0,
            "stdout": "Terraform has been successfully initialized!"
        }
    }
};

tr.setAnswers(a);
tr.run();
