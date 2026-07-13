// Full-task test: kbId='list' -> the list-KB-mode branch (getKnowledgeBases),
// which returns before any dry-run/create/update logic. Previously never
// exercised by any test.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('kbId', 'list');

tr.registerMock('./servicenow-client', {
  getKnowledgeBases: async () => [{ title: 'IT Knowledge Base', sys_id: 'kb-sys-1' }],
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
