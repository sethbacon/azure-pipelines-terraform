import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// Strict mode (#488/#492): with failOnSensitiveOutputs=true and cleanup NOT
// requested, a sensitive output in the terraform output -json file must fail
// the task instead of only warning -- and the just-written file must be
// deleted by the end-of-step cleanup so the failure doesn't leave the
// cleartext values behind. Uses a real working directory and the
// ParentCommandHandler (via runViaParentHandler) so cleanupTempFiles()
// actually runs from the execute() finally block.
const workingDirectory = path.join(os.tmpdir(), 'tf-output-strict-fail-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });
// The file is written under Agent.TempDirectory (#492), so point it at a
// scrubbed per-scenario directory the L0 assertions can inspect.
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-strict-fail-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

let tp = path.join(__dirname, './AWSOutputSensitiveStrictFailsL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('failOnSensitiveOutputs', 'true');
// cleanupOutputFile intentionally left unset -- strict mode only fails when
// the file would be retained.
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
