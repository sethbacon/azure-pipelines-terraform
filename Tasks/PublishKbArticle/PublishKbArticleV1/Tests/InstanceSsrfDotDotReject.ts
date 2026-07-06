// Full-task test: a `serviceNow instance` value containing a slash/dot-dot
// (e.g. 'foo/../bar') must be rejected by the SSRF / credential-redirection
// guard in src/index.ts BEFORE any network client is invoked.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'foo/../bar');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');

tr.registerMock('./auth', {
  getOAuthToken: async () => { throw new Error('NETWORK_CALLED: getOAuthToken'); },
  getAuthHeaders: () => { throw new Error('NETWORK_CALLED: getAuthHeaders'); },
});
tr.registerMock('./servicenow-client', {
  getKnowledgeBases: async () => { throw new Error('NETWORK_CALLED: getKnowledgeBases'); },
  getArticle: async () => { throw new Error('NETWORK_CALLED: getArticle'); },
  createKnowledgeArticle: async () => { throw new Error('NETWORK_CALLED: createKnowledgeArticle'); },
  updateKnowledgeArticle: async () => { throw new Error('NETWORK_CALLED: updateKnowledgeArticle'); },
  changeWorkflowState: async () => { throw new Error('NETWORK_CALLED: changeWorkflowState'); },
  findArticleBySourceKey: async () => { throw new Error('NETWORK_CALLED: findArticleBySourceKey'); },
  updateArticleBody: async () => { throw new Error('NETWORK_CALLED: updateArticleBody'); },
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
