import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './AzureForceUnlockSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'forceunlock');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('lockId', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
tr.setInput('commandOptions', '');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform force-unlock -force a1b2c3d4-e5f6-7890-abcd-ef1234567890": {
            "code": 0,
            "stdout": "Terraform state has been successfully unlocked!"
        }
    }
}

tr.setAnswers(a);
tr.run();
