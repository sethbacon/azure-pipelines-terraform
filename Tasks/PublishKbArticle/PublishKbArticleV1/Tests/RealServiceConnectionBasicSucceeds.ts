// Full-task test: a service connection that uses the Basic scheme, with authType
// left to its task.json default. The agent hands an input the pipeline never set
// its default value, so a real run reads authType = 'oauth' next to a Basic
// connection. The mock runner applies no task.json defaults, so that value is set
// by hand here; the connection's scheme has to win, or the run attempts OAuth
// with credentials the connection does not have.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-sc-basic-'));

tr.setInput('serviceConnection', 'MyKbBasicConnection');
tr.setInput('authType', 'oauth');
tr.setInput('articleId', 'existing-art-id');
tr.setInput('workflowState', 'publish');
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

process.env['ENDPOINT_URL_MyKbBasicConnection'] = 'https://sc-instance.service-now.com';
process.env['ENDPOINT_AUTH_SCHEME_MyKbBasicConnection'] = 'UsernamePassword';
process.env['ENDPOINT_AUTH_PARAMETER_MyKbBasicConnection_USERNAME'] = 'sc-user';
process.env['ENDPOINT_AUTH_PARAMETER_MyKbBasicConnection_PASSWORD'] = 'sc-password';

tr.registerMock('./auth', {
  getOAuthToken: async () => {
    console.log('##[MOCK] getOAuthToken called');
    return 'unexpected-oauth-token';
  },
  getAuthHeaders: (type: string, opts: { username?: string; password?: string }) => {
    console.log(`##[MOCK] getAuthHeaders called with type=${type} username=${opts.username}`);
    return {
      Authorization: 'Basic mock-basic-credentials',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  },
});
tr.registerMock('./servicenow-client', {
  changeWorkflowState: async () => ({ sys_id: 'existing-art-id', number: 'KB0054', workflow_state: 'published' }),
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
