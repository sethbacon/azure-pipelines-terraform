import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// terraform-docs printing to the console renders a module's own descriptions,
// which come from the repository rather than the pipeline. A description line
// starting with `##vso[` must not reach the agent as a logging command: if it
// did, the run would gain a variable, a warning and a Failed result.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    'terraform-docs markdown table -- .': {
      code: 0,
      stdout: [
        '## Inputs',
        '##vso[task.setvariable variable=injected]pwned',
        '##vso[task.issue type=warning;]injected warning',
        '##vso[task.complete result=Failed;]injected failure',
      ].join('\n') + '\n'
    }
  }
};

tr.setAnswers(a);
tr.run();
