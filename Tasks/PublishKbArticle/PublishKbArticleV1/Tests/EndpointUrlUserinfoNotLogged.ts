// Class test for #1105 (credential-capable input read), service-connection
// flavour: task-lib's getEndpointUrl() reads the un-vaulted ENDPOINT_URL_<id>
// variable and debug-logs it whole, so a credential an operator put into the
// connection's URL (https://svc:token@instance.service-now.com) reaches the
// log before anything could mask it. readEndpointUrl registers the userinfo
// first and logs the URL redacted, and the instance name is taken from the
// PARSED host so the userinfo never rides into `instance` (where a scheme-less
// "svc:token@instance" could not be redacted by the InvalidInstance message).
// The run is stopped at the first ServiceNow call with a STOP_HERE mock: reaching
// it proves the instance was derived cleanly and validation passed.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('serviceConnection', 'KbConn');
process.env['ENDPOINT_URL_KbConn'] = 'https://svc:ep-s3cr3t-value@sc-instance.service-now.com';
process.env['ENDPOINT_AUTH_SCHEME_KbConn'] = 'UsernamePassword';
process.env['ENDPOINT_AUTH_PARAMETER_KbConn_USERNAME'] = 'kb-publisher';
process.env['ENDPOINT_AUTH_PARAMETER_KbConn_PASSWORD'] = 'conn-pw';

tr.registerMock('./auth', {
  getOAuthToken: async () => { throw new Error('STOP_HERE: getOAuthToken'); },
  getAuthHeaders: () => { throw new Error('STOP_HERE: getAuthHeaders'); },
});
tr.registerMock('./servicenow-client', {
  getKnowledgeBases: async () => { throw new Error('STOP_HERE: getKnowledgeBases'); },
  getArticle: async () => { throw new Error('STOP_HERE: getArticle'); },
  createKnowledgeArticle: async () => { throw new Error('STOP_HERE: createKnowledgeArticle'); },
  updateKnowledgeArticle: async () => { throw new Error('STOP_HERE: updateKnowledgeArticle'); },
  changeWorkflowState: async () => { throw new Error('STOP_HERE: changeWorkflowState'); },
  findArticleBySourceKey: async () => { throw new Error('STOP_HERE: findArticleBySourceKey'); },
  updateArticleBody: async () => { throw new Error('STOP_HERE: updateArticleBody'); },
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
