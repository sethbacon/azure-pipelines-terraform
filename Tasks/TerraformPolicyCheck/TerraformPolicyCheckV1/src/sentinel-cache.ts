import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import fs = require('fs');

/**
 * Sentinel keeps a cache, `.sentinel/`, in the directory it runs in. The cache
 * records the absolute path of every module and policy it loaded, with no
 * checksum, and the next run in that directory loads from the recorded paths
 * instead of resolving the configuration again. Measured with Sentinel 0.41.0
 * (`sentinel apply` and `sentinel test`):
 *
 *   - A policy set copied together with its cache evaluated the modules of the
 *     copy it came from, and passed a plan the copied set rejects.
 *   - A cache from another machine names paths that do not exist here, and the
 *     run fails with "Error parsing modules".
 *
 * A policy source can carry a cache: committed by mistake, copied from another
 * checkout, or left by an earlier run on a reused agent. HCP Terraform reads a
 * fresh copy of the repository for every run, so the task removes the cache
 * before Sentinel runs, and removes the one that run writes afterwards.
 */
export const SENTINEL_CACHE_DIR = '.sentinel';

/**
 * Removes the cache, reporting whether there was one. A missing cache is the
 * normal case; any other failure is thrown. A `.sentinel` symlink is removed
 * itself: recursive removal does not follow a link.
 */
function removeCache(cacheDir: string): boolean {
    try {
        fs.rmSync(cacheDir, { recursive: true });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
    }
}

/** Runs Sentinel (`run`) in `workingDir` with no cache before it and none after. */
export async function withFreshSentinelCache<T>(workingDir: string, run: () => Promise<T>): Promise<T> {
    const cacheDir = path.join(workingDir, SENTINEL_CACHE_DIR);
    let removed: boolean;
    try {
        removed = removeCache(cacheDir);
    } catch (err) {
        throw new Error(
            `Could not remove Sentinel's cache ${cacheDir} before running Sentinel: ${err instanceof Error ? err.message : String(err)}. ` +
            `Sentinel would load the modules and policies recorded in it, which need not be the ones in the policy source.`,
        );
    }
    if (removed) {
        console.log(`Removed Sentinel's cache ${cacheDir}, which came with the policy source: Sentinel loads modules and policies from the paths it records, which need not be this source's.`);
    }
    try {
        return await run();
    } finally {
        try {
            removeCache(cacheDir);
        } catch (err) {
            tasks.warning(`Could not remove Sentinel's cache ${cacheDir} after the run: ${err instanceof Error ? err.message : String(err)}. The next run removes it before starting.`);
        }
    }
}
