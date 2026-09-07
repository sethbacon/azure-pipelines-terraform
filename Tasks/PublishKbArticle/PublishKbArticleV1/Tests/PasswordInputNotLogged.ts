// Class test for #1105 (credential-capable input read): a password-typed input
// holds a literal the operator typed -- NOT a secret variable, so the agent
// has never registered it -- and task-lib's getInput() would print it on its
// own `##vso[task.debug]password=...` line at the moment of the read, before
// resolveAuth's setSecret could run. readSecretInput registers the value
// first and writes that line as `password=***`. Like the sibling
// ClientSecretMaskedBeforeInstanceThrow fixture, `instance` is left unset so
// the task stops at InstanceRequired right after the reads.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('authType', 'basic');
tr.setInput('username', 'kb-publisher');
tr.setInput('password', 'basic-pw-s3cr3t-literal');

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
