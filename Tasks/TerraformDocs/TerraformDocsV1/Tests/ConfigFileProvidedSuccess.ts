import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// A genuinely-provided config file (an existing regular file) must be forwarded
// as `--config <file>`. Use the task's own task.json as a guaranteed-present
// regular file.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const existingFile = path.join(__dirname, '..', 'task.json');

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');
tr.setInput('configFile', existingFile);

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    [`terraform-docs markdown table --config ${existingFile} -- .`]: {
      code: 0,
      stdout: 'generated'
    }
  }
};

tr.setAnswers(a);
tr.run();
