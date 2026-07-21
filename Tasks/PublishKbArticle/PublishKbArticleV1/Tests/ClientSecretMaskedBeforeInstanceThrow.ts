// Full-task test: regression guard for #771 -- resolveAuth() must mask an
// inline clientSecret via tasks.setSecret() at the POINT OF READ, before the
// missing-instance check throws. getOAuthToken() (invoked later, only on the
// happy path) also masks clientSecret, but that call is never reached here --
// omitting `instance` makes resolveAuth throw InstanceRequired immediately
// after reading the inline inputs. Pre-#771, clientSecret was only masked
// inside getOAuthToken()/basicAuthHeader(), so this exact early-throw path
// would leave it completely unregistered in the agent's log-masking registry.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('authType', 'oauth');
tr.setInput('clientId', 'my-client-id');
tr.setInput('clientSecret', 'super-secret-oauth-value');
// `instance` is intentionally left unset so resolveAuth() throws
// InstanceRequired right after reading/masking the inline credentials.

// If the missing-instance guard were bypassed, these would be invoked --
// fail loudly so an escaped call (and a real un-mocked network attempt) is
// unmistakable, mirroring the sibling instance-SSRF-guard fixtures.
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
