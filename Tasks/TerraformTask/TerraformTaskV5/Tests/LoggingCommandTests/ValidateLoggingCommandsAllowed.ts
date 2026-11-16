import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The opt-out: with allowTerraformLoggingCommands the task streams terraform's
// output exactly as it did before filtering existed, so a pipeline that prints
// logging commands on purpose (a local-exec provisioner echoing
// task.setvariable, say) keeps working, and the task warns that it is doing so.
let tp = path.join(__dirname, './ValidateLoggingCommandsAllowedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'validate');
tr.setInput('allowTerraformLoggingCommands', 'true');

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
                "##vso[task.setvariable variable=deliberate]value",
                "##vso[task.issue type=warning;]deliberate warning",
            ].join('\n')
        }
    }
}

tr.setAnswers(a);
tr.run();
