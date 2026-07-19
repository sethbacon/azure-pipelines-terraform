import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

    it('downloadSecureFile delegates to the injected helper, returns the path, and tightens its permissions', async () => {
        // A real file: downloadSecureFile chmods the path after "download",
        // which needs an actual file on disk to chmod (#355).
        const realPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-securefile-')), 'vars.tfvars');
        fs.writeFileSync(realPath, 'secret = "value"\n', { mode: 0o644 });

        let requested = '';
        const loader = new SecureFileLoader({
            downloadSecureFile: async (id: string) => { requested = id; return realPath; },
            deleteSecureFile: () => { /* unused */ },
        });
        const filePath = await loader.downloadSecureFile('file-1');
        assert.strictEqual(filePath, realPath);
        assert.strictEqual(requested, 'file-1');
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(realPath).mode & 0o777, 0o600, 'downloaded secure file should be chmod 0600');
        }
    });

    it('downloadSecureFile fails fast when the download exceeds the timeout', async () => {
        // The vendored securefiles-common download has no socket timeout, so a
        // stalled download would hang the task indefinitely; the loader bounds it.
        const loader = new SecureFileLoader(
            {
                downloadSecureFile: () => new Promise<string>(() => { /* never resolves */ }),
                deleteSecureFile: () => { /* unused */ },
            },
            50,
        );
        await assert.rejects(
            loader.downloadSecureFile('hung-file'),
            /Secure file download timed out after 50ms/,
        );
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

    it('deleteSecureFile scrubs the downloaded file before delegating to the helper (#662)', () => {
        const realPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-securefile-del-')), 'vars.tfvars');
        const original = 'secret = "top-secret-value"\n';
        fs.writeFileSync(realPath, original);
        let deletedId = '';
        let scrubbedBeforeDelete = false;
        const loader = new SecureFileLoader({
            downloadSecureFile: async () => '',
            deleteSecureFile: (id: string) => {
                deletedId = id;
                // The helper runs AFTER the scrub, so the bytes are already zeroed here.
                const bytes = fs.readFileSync(realPath);
                scrubbedBeforeDelete = bytes.length === Buffer.byteLength(original) && bytes.every(b => b === 0);
            },
        });
        loader.deleteSecureFile('file-4', realPath);
        assert.strictEqual(deletedId, 'file-4');
        assert.ok(scrubbedBeforeDelete, 'the downloaded secure file must be zero-scrubbed before the helper unlinks it');
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
        // filePath is surfaced so the caller can scrub the downloaded secure file
        // before it is unlinked (#662).
        assert.deepStrictEqual(result, { varFileArg: '-var-file=/secure/path.tfvars', secureFileId: 'secure-id-9', filePath: '/secure/path.tfvars' });
        assert.strictEqual(downloaded, 'secure-id-9');
    });
});
