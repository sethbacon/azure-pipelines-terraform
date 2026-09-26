/**
 * Maps `items` through `fn` with at most `limit` calls in flight, returning the
 * results in input order. Used for attachment downloads: one at a time made a
 * ten-plan run wait for ten round trips, and all at once would open as many
 * connections as a run has attachments.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
    await Promise.all(workers);
    return results;
}
