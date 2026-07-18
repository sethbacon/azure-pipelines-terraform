import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Free-form additional arguments are appended verbatim after the built flag
// arguments but BEFORE the `--` module-path terminator, so a flag carried in
// additionalArgs (e.g. --hide-empty) is still parsed as a flag rather than
// being swallowed as an extra positional after `--` (#661).
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');
tr.setInput('additionalArgs', '--hide-empty');

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    'terraform-docs markdown table --hide-empty -- .': {
      code: 0,
      stdout: 'ok'
    }
  }
};

tr.setAnswers(a);
tr.run();
