import { describe, it, afterEach } from 'mocha';
import assert = require('assert');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import { createModuleArchive, MAX_ARCHIVE_BYTES } from '../src/archive';

/** Minimal ustar reader: enough to assert names, sizes and contents of what was archived. */
function readTar(gz: Uint8Array): Array<{ name: string; content: string; mode: string; mtime: string }> {
    const tar = gunzipSync(gz);
    const files: Array<{ name: string; content: string; mode: string; mtime: string }> = [];
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        const field = (start: number, len: number): string => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '');
        const name = field(0, 100);
        const prefix = field(345, 155);
        const size = parseInt(field(124, 12), 8);
        files.push({
            name: prefix ? `${prefix}/${name}` : name,
            content: tar.subarray(offset + 512, offset + 512 + size).toString('utf8'),
            mode: field(100, 8),
            mtime: field(136, 12),
        });
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

describe('module archive', () => {
    const made: string[] = [];
    const tmp = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfmod-archive-'));
        made.push(dir);
        return dir;
    };
    const write = (root: string, rel: string, content = 'x'): void => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    afterEach(() => {
        while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
    });

    it('puts the module files at the archive root, in sorted order, with normalised metadata', async () => {
        const dir = tmp();
        write(dir, 'variables.tf', 'variable "a" {}');
        write(dir, 'main.tf', 'resource "x" "y" {}');
        write(dir, 'modules/inner/main.tf', 'inner');
        const files = readTar(await createModuleArchive(dir));
        assert.deepStrictEqual(files.map((f) => f.name), ['main.tf', 'modules/inner/main.tf', 'variables.tf']);
        assert.strictEqual(files[0].content, 'resource "x" "y" {}');
        assert.ok(files.every((f) => /^0+644$/.test(f.mode)), 'mode pinned to 0644');
        assert.ok(files.every((f) => /^0+$/.test(f.mtime)), 'mtime pinned to 0');
    });

    it('is deterministic: the same content yields byte-identical archives', async () => {
        const dir = tmp();
        write(dir, 'main.tf', 'a');
        write(dir, 'b.tf', 'b');
        const first = Buffer.from(await createModuleArchive(dir));
        // Touching the file changes its mtime on disk but must not change the archive.
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(dir, 'main.tf'), later, later);
        const second = Buffer.from(await createModuleArchive(dir));
        assert.ok(first.equals(second));
    });

    it('excludes .git and .terraform directories', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        write(dir, '.git/config', 'secret');
        write(dir, '.terraform/providers/x', 'big');
        assert.deepStrictEqual(readTar(await createModuleArchive(dir)).map((f) => f.name), ['main.tf']);
    });

    it('drops files and directories matching exclude patterns', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        write(dir, 'pipeline.yml');
        write(dir, 'validation.tfvars');
        write(dir, 'tests/unit.tf');
        write(dir, 'modules/inner/main.tf');
        write(dir, 'modules/inner/dev.tfvars');
        const names = async (exclude: string[]): Promise<string[]> =>
            readTar(await createModuleArchive(dir, exclude)).map((f) => f.name);

        assert.deepStrictEqual(await names(['pipeline.yml', 'tests']), [
            'main.tf', 'modules/inner/dev.tfvars', 'modules/inner/main.tf', 'validation.tfvars',
        ]);
        // `*` stays within one segment, so the root pattern leaves the nested file alone.
        assert.ok((await names(['*.tfvars'])).includes('modules/inner/dev.tfvars'));
        assert.ok(!(await names(['*.tfvars'])).includes('validation.tfvars'));
        assert.ok(!(await names(['**/*.tfvars'])).includes('modules/inner/dev.tfvars'));
        assert.deepStrictEqual(await names(['./modules/', '', '  ']), ['main.tf', 'pipeline.yml', 'tests/unit.tf', 'validation.tfvars']);
    });

    it('treats regex characters in an exclude pattern literally', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        write(dir, 'a+b.tf');
        write(dir, 'aab.tf');
        assert.deepStrictEqual(readTar(await createModuleArchive(dir, ['a+b.tf'])).map((f) => f.name), ['aab.tf', 'main.tf']);
    });

    it('still reports a module with no root .tf file when the exclusions remove it', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        await assert.rejects(() => createModuleArchive(dir, ['main.tf']), /no \.tf or \.tf\.json files/);
    });

    it('accepts a module made only of .tf.json files', async () => {
        const dir = tmp();
        write(dir, 'main.tf.json', '{}');
        assert.deepStrictEqual(readTar(await createModuleArchive(dir)).map((f) => f.name), ['main.tf.json']);
    });

    it('refuses a directory with no Terraform files at its root', async () => {
        const dir = tmp();
        write(dir, 'README.md');
        await assert.rejects(() => createModuleArchive(dir), /no \.tf or \.tf\.json files at its root/);
    });

    it('refuses a module nested one level down (HCP would accept it and publish an unusable version)', async () => {
        const dir = tmp();
        write(dir, 'terraform-aws-vpc/main.tf');
        await assert.rejects(() => createModuleArchive(dir), /no \.tf or \.tf\.json files at its root/);
    });

    it('refuses a directory that does not exist', async () => {
        await assert.rejects(() => createModuleArchive(path.join(os.tmpdir(), 'tfmod-does-not-exist-xyz')), /not a directory that exists/);
    });

    it('refuses a path that is a file, not a directory', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        await assert.rejects(() => createModuleArchive(path.join(dir, 'main.tf')), /not a directory that exists/);
    });

    it('carries a path longer than 100 bytes through the ustar prefix field', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        const deep = path.join('a'.repeat(60), 'b'.repeat(60), 'file.tf');
        write(dir, deep);
        const names = readTar(await createModuleArchive(dir)).map((f) => f.name);
        assert.ok(names.includes(`${'a'.repeat(60)}/${'b'.repeat(60)}/file.tf`), `got ${names.join(',')}`);
    });

    it('refuses a path that cannot fit the tar name/prefix fields', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        write(dir, 'n'.repeat(120) + '.tf');
        await assert.rejects(() => createModuleArchive(dir), /does not fit the tar format/);
    });

    it('refuses an archive larger than the size cap', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(MAX_ARCHIVE_BYTES + 1));
        await assert.rejects(() => createModuleArchive(dir), /exceeds .* bytes uncompressed/);
    });

    it('refuses a symbolic link that points outside the module directory', async function () {
        const dir = tmp();
        const outside = tmp();
        write(dir, 'main.tf');
        write(outside, 'secret.txt', 'top secret');
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'), 'file');
        } catch {
            // Creating a symlink needs a privilege some Windows agents lack; the
            // containment logic is platform-independent and covered on the other OS leg.
            return;
        }
        await assert.rejects(() => createModuleArchive(dir), /symbolic link pointing outside/);
    });

    it('refuses a broken symbolic link', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        try {
            fs.symlinkSync(path.join(dir, 'nope'), path.join(dir, 'dangling.tf'), 'file');
        } catch {
            return;
        }
        await assert.rejects(() => createModuleArchive(dir), /broken symbolic link/);
    });

    it('refuses a symbolic link to a directory even inside the module', async () => {
        const dir = tmp();
        write(dir, 'main.tf');
        write(dir, 'real/x.tf');
        try {
            fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'), 'dir');
        } catch {
            return;
        }
        await assert.rejects(() => createModuleArchive(dir), /symbolic link to a directory/);
    });

    it('follows a symbolic link to a file inside the module', async () => {
        const dir = tmp();
        write(dir, 'main.tf', 'real');
        try {
            fs.symlinkSync(path.join(dir, 'main.tf'), path.join(dir, 'alias.tf'), 'file');
        } catch {
            return;
        }
        const files = readTar(await createModuleArchive(dir));
        assert.deepStrictEqual(files.map((f) => f.name), ['alias.tf', 'main.tf']);
        assert.strictEqual(files[0].content, 'real');
    });
});
