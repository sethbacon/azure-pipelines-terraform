import { readdir, readFile, realpath, stat } from 'fs/promises';
import { basename, join, relative, resolve, sep } from 'path';
import { gzipSync } from 'zlib';

/**
 * Builds the gzipped module archive HCP Terraform expects at a version's
 * `links.upload` URL.
 *
 * Written here rather than pulled in as a `tar` dependency or shelled out to
 * the system binary: every dependency is a supply-chain edge on a task that
 * publishes modules, while `tar(1)` differs between GNU and bsdtar across the
 * agents this task supports and produces a different archive on every run. The
 * code below emits plain POSIX ustar, which every extractor including HCP's reads.
 *
 * Deliberately free of azure-pipelines-task-lib so it stays a pure leaf module.
 */

/** Directory names never archived: VCS metadata and provider caches, not module source. */
const EXCLUDED_DIRECTORIES = new Set(['.git', '.terraform']);

/**
 * Ceiling on the uncompressed archive.
 *
 * The archive is assembled in memory, so an unbounded walk is an OOM on the
 * agent rather than a failed publish -- and a directory that large is a
 * mis-pointed `moduleDirectory` (a whole monorepo, a `vendor/`, a build output
 * tree) far more often than it is a real module.
 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * Compiles `moduleExclude` patterns into a predicate over module-relative POSIX paths.
 * `*` matches within one path segment, `**` across segments; a pattern that matches a
 * directory drops everything under it. Anchored at the module root, case-sensitive.
 */
export function excludeMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
    const regexes = patterns
        .map((pattern) => pattern.trim().replace(/^(\.?\/)+/, '').replace(/\/+$/, ''))
        .filter((pattern) => pattern !== '')
        .map((pattern) => {
            const source = pattern
                .split('**')
                .map((part) => part.split('*').map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
                .join('.*');
            return new RegExp(`^${source}$`);
        });
    return (relativePath) => regexes.some((regex) => regex.test(relativePath));
}

/** A file destined for the archive, at its path relative to the module root. */
interface Entry {
    path: string;
    content: Buffer;
}

/** Renders one numeric tar header field: octal, zero-padded, NUL-terminated. */
function octalField(value: number, length: number): string {
    return value.toString(8).padStart(length - 1, '0') + '\0';
}

/**
 * Splits a path across ustar's `prefix` (155 bytes) and `name` (100 bytes)
 * fields, which carries a path longer than 100 bytes without reaching for a
 * GNU or PAX extension that a strict reader would reject.
 */
function splitName(path: string): { name: string; prefix: string } {
    if (Buffer.byteLength(path) <= 100) {
        return { name: path, prefix: '' };
    }
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
        const prefix = path.slice(0, i);
        const name = path.slice(i + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
            return { name, prefix };
        }
    }
    throw new Error(
        `Cannot archive '${path}': the path does not fit the tar format's 100-byte name / 155-byte ` +
            'prefix fields. Shorten the path inside the module.',
    );
}

/**
 * One 512-byte ustar header.
 *
 * Every ownership and timestamp field is pinned to a constant (mode 0644, uid
 * and gid 0, mtime 0, no uname/gname) so the same module content always
 * produces the same archive bytes, independent of the agent's umask and clock.
 */
function tarHeader(path: string, size: number): Buffer {
    const { name, prefix } = splitName(path);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(octalField(0o644, 8), 100, 8, 'ascii');
    header.write(octalField(0, 8), 108, 8, 'ascii'); // uid
    header.write(octalField(0, 8), 116, 8, 'ascii'); // gid
    header.write(octalField(size, 12), 124, 12, 'ascii');
    header.write(octalField(0, 12), 136, 12, 'ascii'); // mtime
    // The checksum is computed over a header whose own checksum field reads as
    // eight spaces, so it is seeded that way and overwritten afterwards.
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii'); // typeflag: regular file
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');

    let checksum = 0;
    for (const byte of header) checksum += byte;
    // Six octal digits, NUL, space -- the POSIX spelling.
    header.write(octalField(checksum, 7) + ' ', 148, 8, 'ascii');
    return header;
}

/** Pads to the tar 512-byte block boundary. */
function padding(size: number): Buffer {
    const remainder = size % 512;
    return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - remainder);
}

/**
 * Collects the files under `root`, refusing the shapes that would publish
 * something other than the module.
 *
 * A symlink is resolved and checked for containment before anything is read. A
 * link pointing out of the module directory is refused rather than followed:
 * this archive is uploaded to a registry, so following
 * `secrets -> ~/.docker/config.json` in a checkout the pipeline did not write
 * would turn a publish step into an exfiltration primitive.
 */
async function collect(
    root: string,
    directory: string,
    entries: Entry[],
    total: { bytes: number },
    isExcluded: (relativePath: string) => boolean,
): Promise<void> {
    // Sorted, so archive contents do not depend on directory iteration order.
    const dirents = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );

    for (const dirent of dirents) {
        const absolute = join(directory, dirent.name);
        // Checked before the symlink rules: an excluded entry is never published, so it cannot leak.
        if (isExcluded(relative(root, absolute).split(sep).join('/'))) continue;
        let isDirectory = dirent.isDirectory();

        if (dirent.isSymbolicLink()) {
            const target = await realpath(absolute).catch(() => null);
            if (target === null) {
                throw new Error(`Cannot archive '${relative(root, absolute)}': it is a broken symbolic link.`);
            }
            if (target !== root && !target.startsWith(root + sep)) {
                throw new Error(
                    `Refusing to archive '${relative(root, absolute)}': it is a symbolic link pointing outside ` +
                        'the module directory, and following it would publish a file the module does not ' +
                        'contain. Remove the link or point moduleDirectory at a tree without it.',
                );
            }
            isDirectory = (await stat(absolute)).isDirectory();
            if (isDirectory) {
                throw new Error(
                    `Refusing to archive '${relative(root, absolute)}': it is a symbolic link to a directory. ` +
                        'Replace it with the directory itself so what is published is unambiguous.',
                );
            }
        }

        if (isDirectory) {
            if (!EXCLUDED_DIRECTORIES.has(dirent.name)) {
                await collect(root, absolute, entries, total, isExcluded);
            }
            continue;
        }
        // Sockets, FIFOs and devices have no place in a module archive.
        if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;

        const content = await readFile(absolute);
        total.bytes += content.byteLength;
        if (total.bytes > MAX_ARCHIVE_BYTES) {
            throw new Error(
                `The module archive exceeds ${MAX_ARCHIVE_BYTES} bytes uncompressed. Point moduleDirectory at ` +
                    'the module itself rather than a tree that also holds build output or vendored dependencies.',
            );
        }
        // POSIX separators, always: a tar built on a Windows agent must still
        // extract to the same paths everywhere.
        entries.push({ path: relative(root, absolute).split(sep).join('/'), content });
    }
}

/**
 * Archives a Terraform module directory as gzipped ustar, with the module's own
 * files at the archive root -- which is where HCP expects to find `main.tf`,
 * not one level down under the directory's name.
 *
 * @param directory the module root, as supplied by the `moduleDirectory` input.
 * @param exclude `moduleExclude` patterns, applied on top of the built-in exclusions.
 */
export async function createModuleArchive(directory: string, exclude: readonly string[] = []): Promise<Uint8Array> {
    const root = await realpath(resolve(directory)).catch(() => null);
    if (root === null || !(await stat(root)).isDirectory()) {
        throw new Error(`moduleDirectory '${directory}' is not a directory that exists on the agent.`);
    }

    const entries: Entry[] = [];
    await collect(root, root, entries, { bytes: 0 }, excludeMatcher(exclude));

    // HCP accepts an archive with no Terraform files (or the module nested one
    // level down) and reports it `ok`, so this is the only guard against
    // publishing an unusable version.
    const hasConfig = entries.some((entry) => {
        const name = basename(entry.path);
        return !entry.path.includes('/') && (name.endsWith('.tf') || name.endsWith('.tf.json'));
    });
    if (!hasConfig) {
        throw new Error(
            `moduleDirectory '${directory}' contains no .tf or .tf.json files at its root, so it is not a ` +
                'Terraform module. Point moduleDirectory at the module rather than at the repository root.',
        );
    }

    const blocks: Buffer[] = [];
    for (const entry of entries) {
        blocks.push(tarHeader(entry.path, entry.content.byteLength), entry.content, padding(entry.content.byteLength));
    }
    // Two zero blocks terminate a tar archive.
    blocks.push(Buffer.alloc(1024));
    // Level 9, and Node's gzip writes a zero MTIME into the header, so the
    // bytes stay a function of the content alone.
    return gzipSync(Buffer.concat(blocks), { level: 9 });
}
