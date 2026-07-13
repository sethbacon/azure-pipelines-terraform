// Full-task test: dryRun=false, existing articleId + title/content -> real
// UPDATE path (executeCreateOrUpdate's updateKnowledgeArticle branch).
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-update-'));
const htmlFile = path.join(dir, 'article.html');
fs.writeFileSync(htmlFile, '<p>Real update content</p>');

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('articleId', 'existing-art-id');
tr.setInput('title', 'Updated Title');
tr.setInput('htmlFile', htmlFile);
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

tr.registerMock('./servicenow-client', {
  updateKnowledgeArticle: async (instance: string, _headers: unknown, articleId: string, title: string) => {
    console.log(`##[MOCK] updateKnowledgeArticle called with instance=${instance} articleId=${articleId} title=${title}`);
    return { sys_id: 'existing-art-id', number: 'KB0050', workflow_state: 'draft' };
  },
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
