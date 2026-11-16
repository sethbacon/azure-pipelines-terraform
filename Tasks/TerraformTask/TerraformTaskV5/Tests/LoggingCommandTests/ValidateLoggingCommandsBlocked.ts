import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// terraform prints three logging commands that a provider, a provisioner or a
// value in remote state could put in its output. With the task's default
// filtering none of them may reach the agent: if they did, the run would get an
// `injected` variable, a warning, and a Failed result.
let tp = path.join(__dirname, './ValidateLoggingCommandsBlockedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'validate');

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers> {
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform validate": {
            "code": 0,
            "stdout": [
                "Success! The configuration is valid.",
                "##vso[task.setvariable variable=injected]pwned",
                "##vso[task.issue type=warning;]injected warning",
                "##vso[task.complete result=Failed;]injected failure",
            ].join('\n')
        }
    }
}

tr.setAnswers(a);
tr.run();
