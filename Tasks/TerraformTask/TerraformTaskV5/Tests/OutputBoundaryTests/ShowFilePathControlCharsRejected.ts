import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// CLASS ROW — setVariable('showFilePath'). The exported value is the RESOLVED
// output path; a working directory whose own name carries a newline (legal on
// POSIX) makes it control-char-bearing, so the same guard that protects
// TF_OUT_* has to reject it here rather than emit a value that would forge a
// second `##vso[...]` logging command. POSIX-only: NTFS cannot hold '\n'.
const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-class-nl\n-'));

const tp = path.join(__dirname, './ShowFilePathControlCharsRejectedL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('outputTo', 'file');
tr.setInput('outputFormat', 'json');
tr.setInput('filename', 'show.json');
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
        'terraform show -json': { 'code': 0, 'stdout': '{"format_version":"1.0"}' }
    }
};

tr.setAnswers(a);
tr.run();
