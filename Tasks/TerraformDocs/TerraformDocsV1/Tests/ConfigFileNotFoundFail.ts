import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// A genuinely-supplied but non-existent config file must fail closed with a
// clear error, rather than being silently dropped or passed through unvalidated.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const missingFile = path.join(__dirname, '..', 'this-config-does-not-exist.yml');

tr.setInput('formatter', 'markdown-table');
tr.setInput('modulePath', '.');
tr.setInput('configFile', missingFile);

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {}
};

tr.setAnswers(a);
tr.run();
