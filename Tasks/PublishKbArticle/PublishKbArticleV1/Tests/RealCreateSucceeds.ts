// Full-task test: dryRun=false, no existing articleId -> real CREATE path
// (executeCreateOrUpdate's createKnowledgeArticle branch). This branch was
// previously 100% untested -- every existing full-task scenario hardcoded
// dryRun=true.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-create-'));
const htmlFile = path.join(dir, 'article.html');
fs.writeFileSync(htmlFile, '<p>Real create content</p>');

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('kbId', 'kb-123');
tr.setInput('title', 'Brand New Article');
tr.setInput('htmlFile', htmlFile);
tr.setInput('author', 'jdoe');
tr.setInput('workflowState', 'draft');
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

tr.registerMock('./servicenow-client', {
  createKnowledgeArticle: async (instance: string, _headers: unknown, kbId: string, title: string, content: string, author: string) => {
    console.log(`##[MOCK] createKnowledgeArticle called with instance=${instance} kbId=${kbId} title=${title} author=${author} contentLen=${content.length}`);
    return { sys_id: 'new-sys-id', number: 'KB0099', workflow_state: 'draft' };
  },
  getKnowledgeBases: async () => [],
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
