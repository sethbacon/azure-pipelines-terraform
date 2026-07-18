import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// The agent resolves an unset optional `filePath` input to the working
// directory, so `configFile` can arrive as an existing directory. It must be
// dropped (no `--config`) rather than forwarded to terraform-docs. Point it at
// a real directory (the task root) and assert no `--config` is emitted.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const existingDirectory = path.join(__dirname, '..');

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');
tr.setInput('configFile', existingDirectory);

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    'terraform-docs markdown table -- .': {
      code: 0,
      stdout: 'generated'
    }
  }
};

tr.setAnswers(a);
tr.run();
