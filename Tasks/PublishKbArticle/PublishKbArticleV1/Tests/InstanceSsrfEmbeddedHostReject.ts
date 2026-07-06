// Full-task test: a `serviceNow instance` value containing an embedded host
// (e.g. 'evil.com') must be rejected by the SSRF / credential-redirection
// guard in src/index.ts BEFORE any network client is invoked — otherwise the
// Bearer/Basic credential would be sent to the attacker-controlled host.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'evil.com');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');

// If instance validation were bypassed, these would be invoked with the
// malicious instance — fail loudly so an escaped call is unmistakable.
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
