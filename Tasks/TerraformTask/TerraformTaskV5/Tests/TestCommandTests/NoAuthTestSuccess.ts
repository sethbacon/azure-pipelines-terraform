import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

let tp = path.join(__dirname, './NoAuthTestSuccessL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'test');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('commandOptions', '');
// No environmentServiceNameAWS — service connection is optional for test

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
  "which": {
    "terraform": "terraform"
  },
  "checkPath": {
    "terraform": true
  },
  "exec": {
    "terraform test": {
      "code": 0,
      "stdout": "Success! 0 passed, 0 failed."
    }
  }
};

tr.setAnswers(a);
tr.run();
