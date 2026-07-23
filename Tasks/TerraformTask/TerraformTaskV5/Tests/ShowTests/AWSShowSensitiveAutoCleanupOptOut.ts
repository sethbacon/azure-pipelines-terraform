import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// #802 opt-out: with cleanupShowFileIfSensitive=false the sensitive `show -json`
// file is RETAINED at normal step end (a downstream step in the SAME job still
// needs to read it via showFilePath) -- the mirror of the #650
// cleanupOutputFileIfSensitive=false opt-out. (On a cancellation it would still
// be scrubbed+deleted via the emergency-only path, where no downstream reader
// remains -- not exercised here, which is the normal-completion case.)
const workingDirectory = path.join(os.tmpdir(), 'tf-show-sensitive-autocleanup-optout-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });

const tp = path.join(__dirname, './AWSShowSensitiveAutoCleanupOptOutL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'show');
tr.setInput('outputTo', 'file');
tr.setInput('outputFormat', 'json');
tr.setInput('filename', 'plan.json');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('cleanupShowFileIfSensitive', 'false');
tr.setInput('environmentServiceNameAWS', 'AWS');

process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'test-access-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'test-secret-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_REGION'] = 'us-east-1';

const planJson = JSON.stringify({
    planned_values: {
        outputs: {
            db_password: { sensitive: true, value: 'hunter2' },
            safe_output: { sensitive: false, value: 'hello' }
        }
    }
});

const a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    'which': { 'terraform': 'terraform' },
    'checkPath': { 'terraform': true },
    'exec': {
        'terraform show -json': {
            'code': 0,
            'stdout': planJson
        }
    }
};

tr.setAnswers(a);
tr.run();
