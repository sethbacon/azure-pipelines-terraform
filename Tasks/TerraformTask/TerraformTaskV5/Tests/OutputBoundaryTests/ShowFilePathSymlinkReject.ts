import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// show(outputTo=file): a filename that only stays inside workingDirectory
// LEXICALLY, via a real in-tree symlink, must also be rejected -- proves the
// call site uses the real realpath-based isWithinWorkingDirectory helper.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-class-showsymlink-'));
const workingDirectory = path.join(root, 'work');
const outside = path.join(root, 'outside');
fs.mkdirSync(workingDirectory);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(workingDirectory, 'link'), 'junction');

const tp = path.join(__dirname, './ShowFilePathSymlinkRejectL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'azurerm');
tr.setInput('command', 'show');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('outputTo', 'file');
tr.setInput('outputFormat', 'json');
tr.setInput('filename', 'link/evil.json');
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
