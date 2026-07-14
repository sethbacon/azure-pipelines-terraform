// Full-task test: dryRun=false, existing articleId + ONLY workflowState (no
// title/content/category/author) -> real WORKFLOW-ONLY path
// (executeCreateOrUpdate's changeWorkflowState branch).
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-workflow-only-'));

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('articleId', 'existing-art-id');
tr.setInput('workflowState', 'publish');
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

tr.registerMock('./servicenow-client', {
  changeWorkflowState: async () => ({ sys_id: 'existing-art-id', number: 'KB0051', workflow_state: 'published' }),
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
