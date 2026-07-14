// Full-task test: auth resolved via a serviceConnection (not inline
// username/password/clientId/clientSecret inputs) using the OAuth branch --
// exercises resolveAuth()'s getEndpointUrl/getEndpointAuthorizationScheme/
// getEndpointAuthorizationParameter wiring, previously untested (every
// existing full-task scenario used inline basic-auth inputs only).
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-sc-oauth-'));

tr.setInput('serviceConnection', 'MyKbConnection');
tr.setInput('articleId', 'existing-art-id');
tr.setInput('workflowState', 'publish');
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

process.env['ENDPOINT_URL_MyKbConnection'] = 'https://sc-instance.service-now.com';
process.env['ENDPOINT_AUTH_SCHEME_MyKbConnection'] = 'OAuth2';
process.env['ENDPOINT_AUTH_PARAMETER_MyKbConnection_CLIENTID'] = 'sc-client-id';
process.env['ENDPOINT_AUTH_PARAMETER_MyKbConnection_CLIENTSECRET'] = 'sc-client-secret';

tr.registerMock('./auth', {
  getOAuthToken: async (instance: string, clientId: string, clientSecret: string) => {
    console.log(`##[MOCK] getOAuthToken called with instance=${instance} clientId=${clientId} clientSecret=${clientSecret}`);
    return 'mock-oauth-access-token';
  },
  getAuthHeaders: (type: string, opts: { accessToken?: string }) => ({
    Authorization: `Bearer ${opts.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }),
});
tr.registerMock('./servicenow-client', {
  changeWorkflowState: async () => ({ sys_id: 'existing-art-id', number: 'KB0053', workflow_state: 'published' }),
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
