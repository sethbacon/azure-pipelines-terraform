import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withFreshSentinelCache, SENTINEL_CACHE_DIR } from '../src/sentinel-cache';

/**
 * Sentinel keeps a cache, `.sentinel/`, in the directory it runs in. The cache
 * records the absolute path of every module and policy, with no checksum, and
 * the next run in that directory uses the recorded paths. Measured with
 * Sentinel 0.41.0: a policy set copied together with its cache evaluated the
 * modules of the copy it came from, and passed a plan the copied set rejects.
 * withFreshSentinelCache removes the cache before and after every Sentinel run.
 */

const POSIX_PERMISSIONS = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('withFreshSentinelCache: Sentinel never reads a cache it did not write in this run', function () {
    let dir: string;
    let output: string[];
    let realWrite: typeof process.stdout.write;

    const cache = (): string => path.join(dir, SENTINEL_CACHE_DIR);
    const exists = (p: string): boolean => {
        try {
            fs.lstatSync(p);
            return true;
        } catch {
            return false;
        }
    };
    // The cache as Sentinel writes it: a manifest per kind, naming absolute paths.
    const writeCache = (): void => {
        fs.mkdirSync(path.join(cache(), 'modules'), { recursive: true });
        fs.writeFileSync(path.join(cache(), 'modules', 'manifest.json'),
            JSON.stringify({ records: [{ key: 'functions', source: '../functions.sentinel', sourceSum: '', dest: '/elsewhere/functions.sentinel' }] }));
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-sentinel-cache-'));
        output = [];
        realWrite = process.stdout.write;
        process.stdout.write = ((chunk: string | Uint8Array): boolean => {
            output.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
    });

    afterEach(() => {
        process.stdout.write = realWrite;
        fs.chmodSync(dir, 0o755);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('removes a cache the policy source arrived with before Sentinel runs, and says so', async () => {
        writeCache();
        let seenByRun: boolean | undefined;
        await withFreshSentinelCache(dir, async () => {
            seenByRun = exists(cache());
        });
        assert.strictEqual(seenByRun, false, 'Sentinel must not start with the cache the source carried');
        assert.ok(output.some(line => line.includes(`Removed Sentinel's cache ${cache()}`)), `output: ${output.join('')}`);
    });

    it("removes the cache the run wrote and returns the run's result", async () => {
        const result = await withFreshSentinelCache(dir, async () => {
            writeCache();
            return 7;
        });
        assert.strictEqual(result, 7);
        assert.strictEqual(exists(cache()), false, 'the cache this run wrote must not outlive it');
        assert.strictEqual(output.length, 0, `a source with no cache has nothing to report: ${output.join('')}`);
    });

    it("removes the cache when the run throws, and rethrows the run's error", async () => {
        await assert.rejects(
            withFreshSentinelCache(dir, async () => {
                writeCache();
                throw new Error('sentinel apply timed out');
            }),
            /sentinel apply timed out/,
        );
        assert.strictEqual(exists(cache()), false);
    });

    if (process.platform !== 'win32') {
        // A repository can commit .sentinel as a symlink; removing it must not
        // reach the directory it points at.
        it('removes a .sentinel symlink without touching what it points to', async () => {
            const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-sentinel-cache-target-'));
            try {
                fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
                fs.symlinkSync(target, cache());
                await withFreshSentinelCache(dir, async () => undefined);
                assert.strictEqual(exists(cache()), false, 'the link itself is removed');
                assert.strictEqual(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8'), 'keep');
            } finally {
                fs.rmSync(target, { recursive: true, force: true });
            }
        });
    }

    if (POSIX_PERMISSIONS) {
        // Running with a cache the task could not remove would evaluate whatever
        // the cache points at, so the run must not start.
        it('refuses to run Sentinel when the cache cannot be removed', async () => {
            writeCache();
            fs.chmodSync(dir, 0o555);
            let ran = false;
            await assert.rejects(
                withFreshSentinelCache(dir, async () => {
                    ran = true;
                }),
                (err: Error) => err.message.includes(`Could not remove Sentinel's cache ${cache()} before running Sentinel`),
            );
            assert.strictEqual(ran, false);
        });

        // After the run the outcome is already decided; a cache left behind is
        // removed again before the next run, so it costs a warning, not the result.
        it('warns, and keeps the result, when the cache cannot be removed after the run', async () => {
            const result = await withFreshSentinelCache(dir, async () => {
                writeCache();
                fs.chmodSync(dir, 0o555);
                return 'passed';
            });
            assert.strictEqual(result, 'passed');
            assert.ok(output.some(line => line.includes('task.issue type=warning') && line.includes(`Could not remove Sentinel's cache ${cache()} after the run`)),
                `output: ${output.join('')}`);
        });
    }
});
