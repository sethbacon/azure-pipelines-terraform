import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './GenericInitSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'init');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
tr.setInput('backendType', 'generic');
tr.setInput('backendConfigArgs', 'address=https://my-backend.example.com/state\nlock=true');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform init -backend-config=address=https://my-backend.example.com/state -backend-config=lock=true": {
            "code": 0,
            "stdout": "Terraform has been successfully initialized!"
        }
    }
};

tr.setAnswers(a);
tr.run();
