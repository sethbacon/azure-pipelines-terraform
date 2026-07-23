import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// #650: an operator can opt OUT of the new auto-cleanup-if-sensitive default
// (cleanupOutputFileIfSensitive=false) when a downstream step in the SAME job
// still needs to read the sensitive value from disk -- the file must then be
// retained after a normal completion exactly like the pre-#650-fix behavior.
const workingDirectory = path.join(os.tmpdir(), 'tf-output-sensitive-autocleanup-optout-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-sensitive-autocleanup-optout-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

let tp = path.join(__dirname, './AWSOutputSensitiveAutoCleanupOptOutL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('cleanupOutputFileIfSensitive', 'false');
tr.setInput('environmentServiceNameAWS', 'AWS');

process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'test-access-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'test-secret-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_REGION'] = 'us-east-1';

let a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    "which": { "terraform": "terraform" },
    "checkPath": { "terraform": true },
    "exec": {
        "terraform output -json": {
            "code": 0,
            "stdout": "{ \"db_password\": { \"value\": \"hunter2\", \"sensitive\": true }, \"safe_output\": { \"value\": \"hello\" } }"
        }
    }
};

tr.setAnswers(a);
tr.run();
