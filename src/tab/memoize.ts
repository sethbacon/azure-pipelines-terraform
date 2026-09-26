/**
 * Memoize a function on the referential identity of its arguments, keeping only
 * the most recent call.
 *
 * The tab's digest arrays come straight out of component state and are never
 * mutated after `loadAll()` stores them, so identity equality is exactly "same
 * input" here. A single-entry cache also cannot grow, whatever a digest contains.
 */
export function memoizeOne<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    let last: { args: A; result: R } | undefined;
    return (...args: A): R => {
        if (last && last.args.length === args.length && last.args.every((arg, i) => Object.is(arg, args[i]))) {
            return last.result;
        }
        const result = fn(...args);
        last = { args, result };
        return result;
    };
}
