import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import os = require('os');
import fs = require('fs');
import {
  CONTROL_CHARS_ADDRESS,
  ANSI_ESCAPE_ADDRESS,
  SCRIPT_MARKUP_ADDRESS,
  QUOTES_BACKSLASH_ADDRESS,
  LONG_ADDRESS,
  DIRECTION_OVERRIDE_ADDRESS,
  HOSTILE_ATTR_NAME,
  HOSTILE_ATTR_ADDRESS,
} from './sarif-hostile-fixtures';

// Pushes genuinely hostile resource addresses/attribute names through the real
// buildDriftSarif/writeSarif path (#898). sarifPath is deliberately left unset
// so writeSarif auto-generates its own unique uuid-named path (see sarif.ts) --
// this fixture only needs mkdtempSync for the plan.json it writes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdr-sarif-hostile-'));

function updateChange(address: string, attrName: string) {
  return {
    address,
    change: {
      actions: ['update'],
      before: { [attrName]: 'old' },
      after: { [attrName]: 'new' },
    },
  };
}

const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(
  planFile,
  JSON.stringify({
    resource_changes: [
      updateChange(CONTROL_CHARS_ADDRESS, 'normal_attr'),
      updateChange(ANSI_ESCAPE_ADDRESS, 'normal_attr'),
      updateChange(SCRIPT_MARKUP_ADDRESS, 'normal_attr'),
      updateChange(QUOTES_BACKSLASH_ADDRESS, 'normal_attr'),
      updateChange(LONG_ADDRESS, 'normal_attr'),
      updateChange(DIRECTION_OVERRIDE_ADDRESS, 'normal_attr'),
      updateChange(HOSTILE_ATTR_ADDRESS, HOSTILE_ATTR_NAME),
    ],
  }),
);

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

tr.setInput('planJsonFile', planFile);
tr.setInput('includeModuleProvenance', 'false');
tr.setInput('failOnDrift', 'false');
tr.setInput('sarifOutput', 'true');

tr.run();
