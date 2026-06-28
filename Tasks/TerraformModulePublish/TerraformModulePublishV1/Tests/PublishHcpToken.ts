import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Drives src/index.ts down the HCP path (hcpToken -> setSecret), with the publisher
// and http transport stubbed so no real network call is made.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'hcp');
tr.setInput('namespace', 'acme');
tr.setInput('name', 'vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('hcpAddress', 'https://app.terraform.io');
tr.setInput('hcpToken', 'super-secret-hcp-token');
tr.setInput('vcsRepoIdentifier', '');
tr.setInput('vcsBranch', 'main');
tr.setInput('vcsOauthTokenId', '');
tr.setInput('commitSha', 'deadbeef');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

// Stub the HTTPS transport so createHttpsClient never opens a socket.
tr.registerMock('./http', {
    createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
});

// Stub HCP publisher: the constructor returns an object whose publish() resolves a
// fake success result matching the real PublishResult shape.
tr.registerMock('./hcp-publisher', {
    HcpPublisher: class {
        publish() {
            return Promise.resolve({ published: true, message: 'Version 1.0.0 published to HCP Terraform.' });
        }
    },
});

// Stub private too so the wrong branch can never touch the network if routing regresses.
tr.registerMock('./private-publisher', {
    PrivateRegistryPublisher: class {
        publish() {
            return Promise.resolve({ published: true, message: 'should not be called' });
        }
    },
});

tr.run();
