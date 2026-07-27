import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './FmtCheckNotFormattedL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'fmt');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('fmtCheck', 'true');
tr.setInput('fmtRecursive', 'true');
tr.setInput('commandOptions', '');

// `terraform fmt -check` reports the unformatted files as a plain list on
// STDOUT and exits non-zero. This must surface the specific
// TerraformFmtNotFormatted message (the positive branch keyed off stdout),
// distinct from the stderr-only crash guarded by FmtCheckCrash.
let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": {
        "terraform": "terraform"
    },
    "checkPath": {
        "terraform": true
    },
    "exec": {
        "terraform fmt -check -recursive": {
            "code": 1,
            "stdout": "main.tf\nmodules/network/variables.tf"
        }
    }
};

tr.setAnswers(a);
tr.run();
