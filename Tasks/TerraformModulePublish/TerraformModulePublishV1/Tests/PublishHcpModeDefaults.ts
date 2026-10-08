import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Same as PublishHcpMode.ts but leaves hcpPublishMode, moduleDirectory and
// vcsBranch UNSET, as a pipeline that predates those inputs would. The task
// must default them (auto, '.', main) rather than fail or send blanks.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'hcp');
tr.setInput('namespace', 'acme');
tr.setInput('name', 'vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('hcpAddress', 'https://app.terraform.io');
tr.setInput('hcpToken', 'super-secret-hcp-token');
tr.setInput('commitSha', 'deadbeef');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

tr.registerMock('./http', {
    createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
});

tr.registerMock('./hcp-publisher', {
    HcpPublisher: class {
        constructor(_http: unknown, options: Record<string, unknown>) {
            console.log('HCP_OPTIONS:' + JSON.stringify({
                publishMode: options.publishMode,
                moduleDirectory: options.moduleDirectory,
                vcsBranch: options.vcsBranch,
            }));
        }
        publish() {
            return Promise.resolve({ published: true, message: 'Version 1.0.0 published to HCP Terraform.' });
        }
    },
});

tr.registerMock('./private-publisher', {
    PrivateRegistryPublisher: class {
        publish() {
            return Promise.resolve({ published: true, message: 'should not be called' });
        }
    },
});

tr.run();
