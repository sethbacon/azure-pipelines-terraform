import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// An hcpPublishMode outside the pick list (e.g. a typo in a pipeline template
// expression) must fail the task up front, before any publisher is constructed
// or any request is made.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'hcp');
tr.setInput('namespace', 'acme');
tr.setInput('name', 'vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('hcpAddress', 'https://app.terraform.io');
tr.setInput('hcpToken', 'super-secret-hcp-token');
tr.setInput('hcpPublishMode', 'tagz');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

tr.registerMock('./http', {
    createHttpsClient: () => () => Promise.reject(new Error('NETWORK_TOUCHED')),
});

tr.registerMock('./hcp-publisher', {
    HcpPublisher: class {
        constructor() {
            console.log('PUBLISHER_CONSTRUCTED');
        }
        publish() {
            return Promise.resolve({ published: true, message: 'should not be called' });
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
