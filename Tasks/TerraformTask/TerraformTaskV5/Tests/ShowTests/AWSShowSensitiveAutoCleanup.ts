import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// #802: a `show -json` file written to the operator-chosen filename (by default
// inside the working directory, unlike output()'s Agent.TempDirectory temp file)
// that contains sensitive plan values is now auto-registered for
// NORMAL-completion scrub+delete by default (cleanupShowFileIfSensitive defaults
// to true), mirroring output()'s #650 handling -- so its cleartext values are not
// left in a working directory a "publish the working directory" artifact step
// could sweep up. Uses ParentCommandHandler (via runViaParentHandler) since
// cleanupTempFiles() only runs from execute()'s finally block.
//
// cleanupShowFileIfSensitive is set explicitly to 'true' here even though that's
// its task.json default: mock-task's getBoolInput() only reads the INPUT_* env
// var tr.setInput() sets and never consults task.json defaults (that resolution
// is the real ADO agent's job, done before the task process starts).
const workingDirectory = path.join(os.tmpdir(), 'tf-show-sensitive-autocleanup-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });

const tp = path.join(__dirname, './AWSShowSensitiveAutoCleanupL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'show');
tr.setInput('outputTo', 'file');
tr.setInput('outputFormat', 'json');
tr.setInput('filename', 'plan.json');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('cleanupShowFileIfSensitive', 'true');
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
