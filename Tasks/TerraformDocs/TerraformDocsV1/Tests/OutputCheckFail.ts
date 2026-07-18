import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// --output-check makes terraform-docs exit non-zero when the file is out of date;
// the task must fail so it can gate a pipeline on stale documentation.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');
tr.setInput('outputFile', 'README.md');
tr.setInput('outputCheck', 'true');

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    'terraform-docs markdown table --output-file README.md --output-check -- .': {
      code: 1,
      stdout: 'README.md is out of date'
    }
  }
};

tr.setAnswers(a);
tr.run();
