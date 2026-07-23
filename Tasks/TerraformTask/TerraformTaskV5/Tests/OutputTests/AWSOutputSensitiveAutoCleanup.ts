import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// #650: a sensitive Terraform output in the `output -json` file is now
// auto-registered for NORMAL-completion scrub+delete by default
// (cleanupOutputFileIfSensitive defaults to true in task.json), even though
// the general cleanupOutputFile input is left off -- closing the residual
// window where the cleartext value was previously retained until the
// agent's end-of-job purge. Uses ParentCommandHandler (via
// runViaParentHandler) since cleanupTempFiles() only runs from execute()'s
// finally block.
//
// cleanupOutputFileIfSensitive is set explicitly to 'true' here even though
// that's its task.json default: mock-task's getBoolInput() only reads the
// INPUT_* env var tr.setInput() sets and never consults task.json defaults
// (that resolution is the real ADO agent's job, done before the task
// process starts) -- leaving it unset here would incorrectly evaluate to
// false under the mock harness, unlike a real pipeline run.
const workingDirectory = path.join(os.tmpdir(), 'tf-output-sensitive-autocleanup-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });
// The file is written under Agent.TempDirectory (#492), so point it at a
// scrubbed per-scenario directory the L0 assertions can inspect.
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-sensitive-autocleanup-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

let tp = path.join(__dirname, './AWSOutputSensitiveAutoCleanupL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', workingDirectory);
// cleanupOutputFile intentionally left unset -- must default to false.
tr.setInput('cleanupOutputFileIfSensitive', 'true');
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
