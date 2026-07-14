// Full-task test: dryRun=false + uploadImages=true -> the image-upload phase
// (processArticleImages + updateArticleBody) runs after a successful update.
// Previously never exercised by any test (every scenario hardcoded
// uploadImages=false).
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-upload-images-'));
const htmlFile = path.join(dir, 'article.html');
fs.writeFileSync(htmlFile, '<p>Body with an image</p><img src="pic.png">');

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('articleId', 'existing-art-id');
tr.setInput('title', 'Article With Image');
tr.setInput('htmlFile', htmlFile);
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'true');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

tr.registerMock('./servicenow-client', {
  updateKnowledgeArticle: async () => ({ sys_id: 'existing-art-id', number: 'KB0052', workflow_state: 'draft' }),
  updateArticleBody: async (_instance: string, _headers: unknown, _sysId: string, text: string) => {
    console.log(`##[MOCK] updateArticleBody called with text: ${text}`);
  },
});
tr.registerMock('./attachments', {
  processArticleImages: async () => ({
    html: '<p>Body with an image</p><img src="sys_attachment.do?sys_id=att-1">',
    uploaded: 1,
    missing: [],
  }),
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
