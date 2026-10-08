import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Drives src/index.ts down the HCP path with an EXPLICIT hcpPublishMode and
// moduleDirectory, and prints the options the publisher was constructed with so
// the test can assert the inputs are actually wired through (not just routed).
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'hcp');
tr.setInput('namespace', 'acme');
tr.setInput('name', 'vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('hcpAddress', 'https://app.terraform.io');
tr.setInput('hcpToken', 'super-secret-hcp-token');
tr.setInput('hcpPublishMode', 'vcsTag');
tr.setInput('moduleDirectory', 'modules/vpc');
tr.setInput('vcsRepoIdentifier', 'acme/proj/_git/terraform-aws-vpc');
tr.setInput('vcsBranch', '');
tr.setInput('vcsOauthTokenId', 'ot-abc');
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
