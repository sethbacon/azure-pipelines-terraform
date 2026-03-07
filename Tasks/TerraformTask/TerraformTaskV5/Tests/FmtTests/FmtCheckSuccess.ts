import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, 'FmtCheckSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'fmt');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('fmtCheck', 'true');
tr.setInput('fmtRecursive', 'true');
tr.setInput('commandOptions', '');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform fmt -check -recursive": {
            "code": 0,
            "stdout": "Formatting check passed."
        }
    }
};

tr.setAnswers(a);
tr.run();
