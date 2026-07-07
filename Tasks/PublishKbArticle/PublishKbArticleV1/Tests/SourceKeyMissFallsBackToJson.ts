// Full-task test: when a `sourceKey` is provided but no article matches the
// wiki-source sentinel (findArticleBySourceKey → null), resolution must FALL
// THROUGH to the legacy KB*.json lookup rather than short-circuiting to a
// create. This proves adopting sourceKey stays backward-compatible with modules
// still tracked by a KB*.json file (no duplicate article is planned).
//
// Runs in dry-run mode so no write is performed; the mocked servicenow-client
// returns the existing article for the resolved id so the plan can be built.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('sourceKey', 'existing-module-key');
tr.setInput('workflowState', 'draft');
tr.setInput('dryRun', 'true');
tr.setInput('skipJsonLookup', 'false');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');

// Source-key lookup MISSES; getArticle returns the article resolved from the
// JSON fallback so the dry-run plan can report its current state.
tr.registerMock('./servicenow-client', {
  getKnowledgeBases: async () => { throw new Error('NETWORK_CALLED: getKnowledgeBases'); },
  getArticle: async () => ({ sys_id: 'json-art-999', workflow_state: 'draft' }),
  createKnowledgeArticle: async () => { throw new Error('NETWORK_CALLED: createKnowledgeArticle'); },
  updateKnowledgeArticle: async () => { throw new Error('NETWORK_CALLED: updateKnowledgeArticle'); },
  changeWorkflowState: async () => { throw new Error('NETWORK_CALLED: changeWorkflowState'); },
  findArticleBySourceKey: async () => null,
  updateArticleBody: async () => { throw new Error('NETWORK_CALLED: updateArticleBody'); },
});

// Legacy JSON fallback returns an existing article id.
tr.registerMock('./manifest', {
  findKbArticleJson: () => ({ article_id: 'json-art-999' }),
  readFrontMatterKey: () => { throw new Error('readFrontMatterKey should not be called'); },
  emitArticleOutput: () => { throw new Error('emitArticleOutput should not be called in dry-run'); },
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
