import { describe, it } from 'mocha';
import assert = require('assert');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateConfig } from '../src/sentinel-engine';

// Direct unit test for the #560 leak fix: the generated sentinel-config temp dir
// must be registered on the cleanup array BEFORE the mkdir/write that can throw,
// so index.ts's finally/cleanup() still removes it when config generation fails
// partway (mirrors policy-source.ts's cloneDir reordering, which is covered by
// the GitCloneFailure scenario).
describe('sentinel config-dir cleanup registration (#560)', () => {
    it('registers the config dir for cleanup before the mkdir that can throw', () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-560-'));
        const policyDir = path.join(scratch, 'policies');
        fs.mkdirSync(policyDir);
        fs.writeFileSync(path.join(policyDir, 'require-tags.sentinel'), 'main = rule { true }');
        // Point Agent.TempDirectory below a regular FILE so mkdirSync(configDir)
        // must fail (ENOTDIR/ENOENT) after the path is registered.
        const blocker = path.join(scratch, 'blocker');
        fs.writeFileSync(blocker, 'not a directory');
        const priorTempDir = process.env['AGENT_TEMPDIRECTORY'];
        process.env['AGENT_TEMPDIRECTORY'] = path.join(blocker, 'nested');
        const tempFiles: string[] = [];
        try {
            assert.throws(() => generateConfig(policyDir, path.join(scratch, 'plan.json'), 'advisory', tempFiles));
            assert.strictEqual(tempFiles.length, 1, 'configDir must be registered even though creation failed');
            assert.ok(path.basename(tempFiles[0]).startsWith('sentinel-config-'), `unexpected registration: ${tempFiles[0]}`);
        } finally {
            if (priorTempDir === undefined) {
                delete process.env['AGENT_TEMPDIRECTORY'];
            } else {
                process.env['AGENT_TEMPDIRECTORY'] = priorTempDir;
            }
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });
});
