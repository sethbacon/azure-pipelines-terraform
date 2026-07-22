import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// A non-zero terraform-docs exit OUTSIDE --output-check (outputCheck unset) is a
// genuine tool failure. It must surface with the captured tool detail folded into
// the message -- not just an opaque exit code -- so the pipeline shows terraform-docs'
// own error text. #767 corrects the --output-check mislabeling AND generalises the
// crash path so every failure carries its detail; the exit code here (2) is a plain
// non-zero, and the stderr deliberately carries no "is out of date" signal.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    'terraform-docs markdown table -- .': {
      code: 2,
      stdout: '',
      stderr: 'Error: unable to parse HCL in main.tf: invalid block definition',
    },
  },
};

tr.setAnswers(a);
tr.run();
