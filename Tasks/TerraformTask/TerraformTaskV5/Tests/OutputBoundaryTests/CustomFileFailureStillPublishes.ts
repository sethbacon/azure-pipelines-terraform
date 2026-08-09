import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// CLASS ROW — custom(outputTo=file). The existing try/finally only guaranteed
// the afterPlanFileWritten hook on a rejecting exec; the write and the
// customFilePath export sat AFTER the await inside the try, so a non-zero exit
// discarded both.
const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-class-customfail-'));

const tp = path.join(__dirname, './CustomFileFailureStillPublishesL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'custom');
tr.setInput('customCommand', 'graph');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('outputTo', 'file');
tr.setInput('filename', 'graph.txt');
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
        'terraform graph': { 'code': 1, 'stdout': 'digraph { partial }' }
    }
};

tr.setAnswers(a);
tr.run();
