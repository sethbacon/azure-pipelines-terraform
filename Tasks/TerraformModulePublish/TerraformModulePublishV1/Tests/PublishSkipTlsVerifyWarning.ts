import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

// Drives src/index.ts down the PRIVATE-registry path with skipTlsVerify=true, so
// the SkipTlsVerifyEnabled warning path is actually exercised (audit id31/#731 --
// no prior test set skipTlsVerify to true and asserted the warning fires). The
// publisher and http transport are stubbed so no real network call is made.
const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('registryType', 'private');
tr.setInput('namespace', 'aceo');
tr.setInput('name', 'networking-vpc');
tr.setInput('provider', 'aws');
tr.setInput('version', '1.0.0');
tr.setInput('registryUrl', 'https://registry.example.com');
tr.setInput('apiKey', 'super-secret-api-key');
tr.setInput('skipTlsVerify', 'true');
tr.setInput('waitForPublish', 'false');
tr.setInput('timeoutSeconds', '180');

// Stub the HTTPS transport so createHttpsClient never opens a socket.
tr.registerMock('./http', {
  createHttpsClient: () => () => Promise.resolve({ status: 200, body: '{}' }),
});

// Stub the private publisher: the constructor returns an object whose publish()
// resolves a fake success result matching the real PublishResult shape.
tr.registerMock('./private-publisher', {
  PrivateRegistryPublisher: class {
    publish() {
      return Promise.resolve({ published: true, message: 'Sync triggered for version 1.0.0.' });
    }
  },
});

// Stub HCP too so the wrong branch can never touch the network if routing regresses.
tr.registerMock('./hcp-publisher', {
  HcpPublisher: class {
    publish() {
      return Promise.resolve({ published: true, message: 'should not be called' });
    }
  },
});

tr.run();
