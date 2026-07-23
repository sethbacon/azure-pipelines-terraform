import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

// #783: when `terraform output -json` returns something that is not parseable
// JSON, both the sensitive-output detection (warnIfSensitiveOutputFile) and the
// TF_OUT_* pipeline-variable export (setOutputVariables) fail to parse it. Those
// two catch blocks previously logged only at debug (invisible unless
// System.Debug is on) while silently exporting ZERO output variables; they now
// warn (visible by default), matching the sibling detectDestroyChanges /
// warnIfSensitiveOutputs handlers.
const agentTempDirectory = path.join(os.tmpdir(), 'tf-output-malformed-json-warns-agenttemp');
fs.rmSync(agentTempDirectory, { recursive: true, force: true });
fs.mkdirSync(agentTempDirectory, { recursive: true });
process.env['AGENT_TEMPDIRECTORY'] = agentTempDirectory;

const tp = path.join(__dirname, './AWSOutputMalformedJsonWarnsL0.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('provider', 'aws');
tr.setInput('command', 'output');
tr.setInput('commandOptions', '');
tr.setInput('workingDirectory', 'DummyWorkingDirectory');
tr.setInput('environmentServiceNameAWS', 'AWS');

process.env['ENDPOINT_AUTH_SCHEME_AWS'] = 'Basic';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_USERNAME'] = 'test-access-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_PASSWORD'] = 'test-secret-key';
process.env['ENDPOINT_AUTH_PARAMETER_AWS_REGION'] = 'us-east-1';

const a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    'which': { 'terraform': 'terraform' },
    'checkPath': { 'terraform': true },
    'exec': {
        'terraform output -json': {
            'code': 0,
            'stdout': 'Error: this is not valid JSON output {'
        }
    }
};

tr.setAnswers(a);
tr.run();
