import * as assert from 'assert';
import tasks = require('azure-pipelines-task-lib/task');
import { SecureFileLoader, getSecureVarFileArgs, ISecureFileLoader } from '../src/secure-file-loader';

/**
 * Direct unit tests for the secure var-file loader. The ADO securefiles-common
 * helper is injected so no real Secure Files download is attempted, and the
 * task-lib input/debug surface is stubbed.
 */
describe('Secure var-file loader', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkeypatch the shared task-lib module
    const t = tasks as any;
    const taskOrig = { getInput: t.getInput, debug: t.debug };
    let inputValue: string | undefined;

    beforeEach(() => {
        inputValue = undefined;
        t.getInput = (name: string) => (name === 'secureVarsFile' ? inputValue : undefined);
        t.debug = () => { /* silence */ };
    });

    afterEach(() => {
        t.getInput = taskOrig.getInput;
        t.debug = taskOrig.debug;
    });

    /* SecureFileLoader class (helpers injected) */

    it('downloadSecureFile delegates to the injected helper and returns the path', async () => {
        let requested = '';
        const loader = new SecureFileLoader({
            downloadSecureFile: async (id: string) => { requested = id; return '/tmp/vars.tfvars'; },
            deleteSecureFile: () => { /* unused */ },
        });
        const filePath = await loader.downloadSecureFile('file-1');
        assert.strictEqual(filePath, '/tmp/vars.tfvars');
        assert.strictEqual(requested, 'file-1');
    });

    it('deleteSecureFile delegates to the injected helper', () => {
        let deleted = '';
        const loader = new SecureFileLoader({
            downloadSecureFile: async () => '',
            deleteSecureFile: (id: string) => { deleted = id; },
        });
        loader.deleteSecureFile('file-2');
        assert.strictEqual(deleted, 'file-2');
    });

    it('deleteSecureFile swallows helper errors', () => {
        const loader = new SecureFileLoader({
            downloadSecureFile: async () => '',
            deleteSecureFile: () => { throw new Error('boom'); },
        });
        assert.doesNotThrow(() => loader.deleteSecureFile('file-3'));
    });

    /* getSecureVarFileArgs */

    it('returns null when no secureVarsFile input is set', async () => {
        inputValue = undefined;
        const result = await getSecureVarFileArgs();
        assert.strictEqual(result, null);
    });

    it('downloads via the provided loader and returns the -var-file argument', async () => {
        inputValue = 'secure-id-9';
        let downloaded = '';
        const loader: ISecureFileLoader = {
            downloadSecureFile: async (id: string) => { downloaded = id; return '/secure/path.tfvars'; },
            deleteSecureFile: () => { /* unused */ },
        };
        const result = await getSecureVarFileArgs(loader);
        assert.deepStrictEqual(result, { varFileArg: '-var-file=/secure/path.tfvars', secureFileId: 'secure-id-9' });
        assert.strictEqual(downloaded, 'secure-id-9');
    });
});
