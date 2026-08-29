import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// custom(outputTo=file): filename had zero working-directory containment check
// before writeCommandOutputFile ran. A traversal value must be rejected before
// the custom terraform command runs.
const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-class-customtraversal-'));

const tp = path.join(__dirname, './CustomFilePathTraversalRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'custom');
tr.setInput('customCommand', 'graph');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('outputTo', 'file');
// Escapes the working directory -- must be rejected before the custom command runs.
tr.setInput('filename', '../../evil.txt');
tr.setInput('commandOptions', '');
tr.setInput('environmentServiceNameAzureRM', 'AzureRM');

process.env['ENDPOINT_AUTH_SCHEME_AzureRM'] = 'ServicePrincipal';
process.env['ENDPOINT_DATA_AzureRM_SUBSCRIPTIONID'] = 'DummmySubscriptionId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALID'] = 'DummyServicePrincipalId';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_SERVICEPRINCIPALKEY'] = 'DummyServicePrincipalKey';
process.env['ENDPOINT_AUTH_PARAMETER_AzureRM_TENANTID'] = 'DummyTenantId';

const a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    'which': { 'terraform': 'terraform' },
    'checkPath': { 'terraform': true },
    'exec': {
        'terraform graph': { 'code': 0, 'stdout': 'digraph { }' }
    }
};

tr.setAnswers(a);
tr.run();
