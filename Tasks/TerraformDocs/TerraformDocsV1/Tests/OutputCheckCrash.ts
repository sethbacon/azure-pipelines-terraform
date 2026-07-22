import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// A non-zero exit under --output-check is NOT always 'docs are out of date':
// terraform-docs also exits non-zero when it genuinely crashes (bad config, an
// unreadable module, a missing --output-file, ...). The task must report those as a
// real failure -- with the captured tool detail folded in -- rather than mislabel
// them 'outdated', which would send the user off to regenerate perfectly current
// docs while the real error stays hidden (#767). The stderr here deliberately does
// NOT contain terraform-docs' "is out of date" signal.
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
      stdout: '',
      stderr: 'Error: unable to read module ".": open main.tf: permission denied',
    },
  },
};

tr.setAnswers(a);
tr.run();
