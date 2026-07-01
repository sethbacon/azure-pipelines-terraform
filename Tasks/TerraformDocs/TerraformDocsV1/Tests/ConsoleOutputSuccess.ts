import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// No output file: terraform-docs prints to the console and no generatedFilePath is set.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('formatter', 'json');
tr.setInput('modulePath', '.');

const a: ma.TaskLibAnswers = {
  which: { 'terraform-docs': 'terraform-docs' },
  checkPath: { 'terraform-docs': true },
  exec: {
    'terraform-docs json .': {
      code: 0,
      stdout: '{}'
    }
  }
};

tr.setAnswers(a);
tr.run();
