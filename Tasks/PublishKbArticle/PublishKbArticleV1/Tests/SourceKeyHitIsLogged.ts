// Full-task test: when a `sourceKey` resolves to an existing article
// (findArticleBySourceKey → a sys_id), the log has to say so and name the
// article, and resolution must stop there rather than going on to the legacy
// KB*.json lookup.
//
// The counterpart of SourceKeyMissFallsBackToJson. Before this, neither outcome
// was logged, so a build log could not show whether the key had matched: an
// update reached through the key and one reached through an explicit articleId
// read the same.
//
// Runs in dry-run mode so no write is performed.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('kbId', 'kb-123');
tr.setInput('sourceKey', 'my-module-key');
tr.setInput('workflowState', 'draft');
tr.setInput('dryRun', 'true');
tr.setInput('skipJsonLookup', 'false');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');

tr.registerMock('./servicenow-client', {
  getKnowledgeBases: async () => { throw new Error('NETWORK_CALLED: getKnowledgeBases'); },
  getArticle: async () => ({ sys_id: 'key-art-123', workflow_state: 'published' }),
  createKnowledgeArticle: async () => { throw new Error('NETWORK_CALLED: createKnowledgeArticle'); },
  updateKnowledgeArticle: async () => { throw new Error('NETWORK_CALLED: updateKnowledgeArticle'); },
  changeWorkflowState: async () => { throw new Error('NETWORK_CALLED: changeWorkflowState'); },
  findArticleBySourceKey: async () => 'key-art-123',
  updateArticleBody: async () => { throw new Error('NETWORK_CALLED: updateArticleBody'); },
});

// A hit must not reach the legacy JSON lookup at all.
tr.registerMock('./manifest', {
  findKbArticleJson: () => { throw new Error('findKbArticleJson should not be called after a source-key hit'); },
  readFrontMatterKey: () => { throw new Error('readFrontMatterKey should not be called'); },
  emitArticleOutput: () => { throw new Error('emitArticleOutput should not be called in dry-run'); },
  sanitizeForSingleLineEcho: (value: string) => value,
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
