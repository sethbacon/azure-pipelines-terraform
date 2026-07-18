#!/usr/bin/env node
// Self-test for check-per-file-coverage.js: exercises the REAL exported
// evaluate() (no mocks of the subject) across every branch — pass, a
// non-exception file below the floor, an exception file below its own floor, a
// stale exception that now clears the default floor, a dangling exception whose
// file vanished, and the exempt-in-range case — plus a sanity check that the
// live EXCEPTIONS map is well-formed. A silent bug here would let a fully
// unexercised module slip under the per-file gate that issue #590 added.
//
// It also exercises the SECURITY_TIER floor added by issue #655: a tiered file
// below SECURITY_FLOOR fails even though it clears DEFAULT_FLOOR, a tiered
// file at/above SECURITY_FLOOR passes, and — the specific bug this tiering
// change could introduce — a tiered file with an EXCEPTIONS entry is judged
// "stale" against its OWN tier floor, not always against DEFAULT_FLOOR (which
// would prematurely flag a still-below-security-floor exception for removal
// the moment it merely cleared the general 60% bar).

const { evaluate, DEFAULT_FLOOR, SECURITY_FLOOR, SECURITY_TIER, EXCEPTIONS } = require('./check-per-file-coverage.js');

let failed = false;
function check(name, cond, extra) {
    if (cond) {
        console.log(`OK: ${name}`);
    } else {
        console.error(`FAIL: ${name}`);
        if (extra !== undefined) console.error(extra);
        failed = true;
    }
}

const TASK = 'Tasks/Foo/FooV1';
// file rel + metrics helper, always task-scoped like the real coverage keys.
const f = (rel, pct, covered = 1, total = 1) => ({ rel: `${TASK}/${rel}`, pct, covered, total });
const ex = (rel, floor, note = 'test') => ({ [`${TASK}/${rel}`]: { floor, note } });
// Every case below is unrelated to tiering unless it opts in via `tier`, so a
// shared default keeps the pre-#655 cases unchanged.
const NO_TIER = new Set();
const run = (files, exceptions = {}, tier = NO_TIER) =>
    evaluate({ taskRel: TASK, files, defaultFloor: DEFAULT_FLOOR, securityFloor: SECURITY_FLOOR, securityTier: tier, exceptions });

// --- Case 1: everything above the default floor, no exceptions -> no failures. ---
{
    const { failures } = run([f('src/a.js', 95), f('src/b.js', 61)]);
    check('clean tree yields no failures', failures.length === 0, failures);
}

// --- Case 2: a non-exception file below the floor -> one floor failure. ---
{
    const { failures } = run([f('src/a.js', 95), f('src/thin.js', 10, 3, 30)]);
    check(
        'non-exception file below floor fails',
        failures.length === 1 && failures[0].includes('thin.js') && failures[0].includes(`${DEFAULT_FLOOR}% per-file floor`),
        failures,
    );
}

// --- Case 3: an exception file below its OWN floor -> failure. ---
{
    const { failures } = run([f('src/legacy.js', 5, 1, 20)], ex('src/legacy.js', 20));
    check(
        'exception file below its own floor fails',
        failures.length === 1 && failures[0].includes('legacy.js') && failures[0].includes('exception floor 20%'),
        failures,
    );
}

// --- Case 4: a stale exception (now clears the default floor) -> failure. ---
{
    const { failures } = run([f('src/legacy.js', 91, 20, 22)], ex('src/legacy.js', 20));
    check(
        'stale exception (now above default floor) fails and asks for removal',
        failures.length === 1 && failures[0].includes('legacy.js') && failures[0].includes('stale entry'),
        failures,
    );
}

// --- Case 5: a dangling exception whose file is absent -> failure. ---
{
    const { failures } = run([f('src/a.js', 95)], ex('src/legacy.js', 20));
    check(
        'dangling exception (file absent) fails',
        failures.length === 1 && failures[0].includes('dangling entry'),
        failures,
    );
}

// --- Case 6: exception file within [floor, defaultFloor) -> exempt, no failure. ---
{
    const { failures, oks } = run([f('src/legacy.js', 24, 8, 34)], ex('src/legacy.js', 20));
    check(
        'exception file in range is exempt (no failure)',
        failures.length === 0 && oks.some((x) => x.startsWith('exempt') && x.includes('legacy.js')),
        { failures, oks },
    );
}

// --- Case 7: exceptions for OTHER tasks are ignored for this task. ---
{
    const exceptions = {
        ...ex('src/legacy.js', 20),
        'Tasks/Bar/BarV1/src/other.js': { floor: 10, note: 'other task' },
    };
    const { failures } = run([f('src/a.js', 95), f('src/legacy.js', 24, 8, 34)], exceptions);
    check('other-task exceptions are neither enforced nor reported dangling here', failures.length === 0, failures);
}

// --- Case 8: a SECURITY_TIER file below SECURITY_FLOOR but ABOVE
// DEFAULT_FLOOR fails (the exact gap issue #655 closes: a flat floor would
// have let this file pass). ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures } = run([f('src/critical.js', 70, 7, 10)], {}, tier);
    check(
        'SECURITY_TIER file below the security floor (but above the default floor) fails',
        failures.length === 1 && failures[0].includes('critical.js') && failures[0].includes(`${SECURITY_FLOOR}% security-tier floor`),
        failures,
    );
}

// --- Case 9: a SECURITY_TIER file at/above SECURITY_FLOOR passes (and is
// labeled as security tier in its OK line). ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures, oks } = run([f('src/critical.js', 85, 8, 10)], {}, tier);
    check(
        'SECURITY_TIER file at/above the security floor passes',
        failures.length === 0 && oks.some((x) => x.includes('critical.js') && x.includes('security tier')),
        { failures, oks },
    );
}

// --- Case 10: a SECURITY_TIER exception file sitting ABOVE DEFAULT_FLOOR but
// BELOW SECURITY_FLOOR must NOT be flagged stale — the bug this tiering change
// could introduce if the "stale" check still compared against DEFAULT_FLOOR
// instead of the file's own (security) floor. ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures, oks } = run([f('src/critical.js', 75, 15, 20)], ex('src/critical.js', 70), tier);
    check(
        'SECURITY_TIER exception file above DEFAULT_FLOOR but below SECURITY_FLOOR is exempt, not stale',
        failures.length === 0 && oks.some((x) => x.startsWith('exempt') && x.includes('critical.js')),
        { failures, oks },
    );
}

// --- Case 11: a SECURITY_TIER exception file that now clears SECURITY_FLOOR
// (its OWN floor) is correctly flagged stale. ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures } = run([f('src/critical.js', 92, 23, 25)], ex('src/critical.js', 70), tier);
    check(
        'SECURITY_TIER exception file that now clears the security floor is flagged stale',
        failures.length === 1 && failures[0].includes('critical.js') && failures[0].includes('stale entry') && failures[0].includes(`${SECURITY_FLOOR}%`),
        failures,
    );
}

// --- Case 12: the live EXCEPTIONS map is well-formed. ---
{
    const entries = Object.entries(EXCEPTIONS);
    const wellFormed = entries.length > 0 && entries.every(([k, v]) =>
        /^Tasks\/[^/]+\/[^/]+\/src\/.+\.js$/.test(k)
        && typeof v.floor === 'number' && v.floor >= 0 && v.floor < (SECURITY_TIER.has(k) ? SECURITY_FLOOR : DEFAULT_FLOOR)
        && typeof v.note === 'string' && v.note.length > 0);
    check('live EXCEPTIONS entries are well-formed (task-scoped .js path, floor below its applicable tier, has note)', wellFormed, EXCEPTIONS);
}

// --- Case 13: the live SECURITY_TIER set is well-formed (task-scoped .js
// paths, matching the same convention as EXCEPTIONS). ---
{
    const wellFormed = SECURITY_TIER.size > 0
        && [...SECURITY_TIER].every((rel) => /^Tasks\/[^/]+\/[^/]+\/src\/.+\.js$/.test(rel));
    check('live SECURITY_TIER entries are well-formed (task-scoped .js paths)', wellFormed, [...SECURITY_TIER]);
}

if (failed) {
    console.error('\ncheck-per-file-coverage.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-per-file-coverage.js self-test: all cases passed.');
