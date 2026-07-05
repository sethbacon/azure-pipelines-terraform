// Full-task test: a well-formed instance name passes the SSRF guard and the
// task proceeds into its normal flow (here: a dry-run workflow-state change
// against a mocked servicenow-client, so no real network call is made).
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('articleId', 'art-123');
tr.setInput('workflowState', 'draft');
tr.setInput('dryRun', 'true');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');

tr.registerMock('./servicenow-client', {
  getArticle: async () => ({ sys_id: 'art-123', workflow_state: 'published' }),
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
