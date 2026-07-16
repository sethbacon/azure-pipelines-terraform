import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// Strict mode is scoped to *retained* files (#488/#492): with BOTH
// failOnSensitiveOutputs=true AND cleanupOutputFile=true the task must still
// succeed -- the file is deleted at the end of the step anyway, so the
// sensitive-output condition stays a warning. Uses a real working directory
// and the ParentCommandHandler so the cleanup actually runs.
const workingDirectory = path.join(os.tmpdir(), 'tf-output-strict-cleanup-test');
fs.rmSync(workingDirectory, { recursive: true, force: true });
fs.mkdirSync(workingDirectory, { recursive: true });
// The file is written under Agent.TempDirectory (#492), so point it at a
// scrubbed per-scenario directory the L0 assertions can inspect.
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-strict-cleanup-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

let tp = path.join(__dirname, './AWSOutputSensitiveStrictCleanupL0.js');
let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', workingDirectory);
tr.setInput('failOnSensitiveOutputs', 'true');
tr.setInput('cleanupOutputFile', 'true');
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
