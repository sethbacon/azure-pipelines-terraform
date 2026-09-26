/**
 * A duration as the apply timeline and summary show it: milliseconds under a
 * second, one decimal of seconds under a minute, then whole minutes and
 * seconds, then whole hours and minutes. Each boundary is tested after
 * rounding, so 59,999 ms reads "1m 0s" rather than "60.0s".
 */
export function formatDuration(ms: number): string {
    const wholeMs = Math.round(ms);
    if (wholeMs < 1000) return `${wholeMs}ms`;
    const tenths = Math.round(ms / 100);
    if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
    const totalMinutes = Math.round(totalSeconds / 60);
    return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
