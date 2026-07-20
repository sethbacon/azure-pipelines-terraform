// Full-task test: dryRun=true with an existing articleId, but getArticle() fails
// with a genuine auth error (401), not a plain not-found. Confirms the dry-run
// path surfaces this loudly (a console warning naming the real error) instead of
// silently normalizing it to "unknown current state" the same way a real 404
// would be treated (audit id27/#727).
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('articleId', 'art-123');
tr.setInput('workflowState', 'draft');
tr.setInput('dryRun', 'true');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');

tr.registerMock('./servicenow-http', {
  ServiceNowHttpError: class ServiceNowHttpError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ServiceNowHttpError';
      this.status = status;
    }
  },
});
tr.registerMock('./servicenow-client', {
  getArticle: async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ServiceNowHttpError } = require('./servicenow-http');
    throw new ServiceNowHttpError('Unauthorized', 401);
  },
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
