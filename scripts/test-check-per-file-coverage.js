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
//
// It also exercises the FUNCTIONS/BRANCHES floors added by issue #777: a
// SECURITY_TIER file whose lines clear their floor still fails if its functions
// or branches coverage falls below the security functions/branches floor; a
// non-tiered file is NOT subject to those floors; and a tiered EXCEPTIONS file
// (a reviewed lines-focused carve-out) is not additionally failed on
// functions/branches.

const { evaluate, DEFAULT_FLOOR, SECURITY_FLOOR, SECURITY_FUNCTIONS_FLOOR, SECURITY_BRANCHES_FLOOR, SECURITY_TIER, EXCEPTIONS } = require('./check-per-file-coverage.js');

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
// funcsPct/branchPct default to 100 so the pre-#777 cases (which only care about
// lines) never trip the new functions/branches security-tier floors.
const f = (rel, pct, covered = 1, total = 1, funcsPct = 100, branchPct = 100) => ({
    rel: `${TASK}/${rel}`,
    pct, covered, total,
    funcsPct, funcsCovered: 1, funcsTotal: 1,
    branchPct, branchCovered: 1, branchTotal: 1,
});
const ex = (rel, floor, note = 'test') => ({ [`${TASK}/${rel}`]: { floor, note } });
// Every case below is unrelated to tiering unless it opts in via `tier`, so a
// shared default keeps the pre-#655 cases unchanged.
const NO_TIER = new Set();
const run = (files, exceptions = {}, tier = NO_TIER) =>
    evaluate({ taskRel: TASK, files, defaultFloor: DEFAULT_FLOOR, securityFloor: SECURITY_FLOOR, securityFunctionsFloor: SECURITY_FUNCTIONS_FLOOR, securityBranchesFloor: SECURITY_BRANCHES_FLOOR, securityTier: tier, exceptions });

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

// --- Case 12a (#777): a SECURITY_TIER file whose LINES clear the floor but
// whose FUNCTIONS coverage is below the security functions floor fails, with a
// message naming functions (not lines). ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures } = run([f('src/critical.js', 95, 19, 20, SECURITY_FUNCTIONS_FLOOR - 10, 100)], {}, tier);
    check(
        'SECURITY_TIER file below the functions floor (lines OK) fails on functions',
        failures.length === 1 && failures[0].includes('critical.js') && failures[0].includes(`${SECURITY_FUNCTIONS_FLOOR}% security-tier functions floor`),
        failures,
    );
}

// --- Case 12b (#777): a SECURITY_TIER file whose LINES and FUNCTIONS clear
// their floors but whose BRANCHES coverage is below the security branches floor
// fails, with a message naming branches. ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures } = run([f('src/critical.js', 95, 19, 20, 100, SECURITY_BRANCHES_FLOOR - 10)], {}, tier);
    check(
        'SECURITY_TIER file below the branches floor (lines/functions OK) fails on branches',
        failures.length === 1 && failures[0].includes('critical.js') && failures[0].includes(`${SECURITY_BRANCHES_FLOOR}% security-tier branches floor`),
        failures,
    );
}

// --- Case 12c (#777): a NON-tiered file with poor functions/branches coverage
// is NOT subject to the functions/branches floors (they apply to SECURITY_TIER
// only) — as long as its lines clear DEFAULT_FLOOR it passes. ---
{
    const { failures } = run([f('src/glue.js', 95, 19, 20, 5, 5)]);
    check(
        'non-tiered file with low functions/branches passes (floors are tier-only)',
        failures.length === 0,
        failures,
    );
}

// --- Case 12d (#777): a SECURITY_TIER file below ALL THREE floors reports one
// failure per metric (lines + functions + branches), not just the first. ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures } = run([f('src/critical.js', 30, 3, 10, 30, 30)], {}, tier);
    check(
        'SECURITY_TIER file below lines, functions and branches reports all three',
        failures.length === 3
        && failures.some((x) => x.includes('security-tier floor'))
        && failures.some((x) => x.includes('security-tier functions floor'))
        && failures.some((x) => x.includes('security-tier branches floor')),
        failures,
    );
}

// --- Case 12e (#777): a tiered EXCEPTIONS file (a reviewed, lines-focused
// carve-out) is judged only on its lines exception floor — its poor
// functions/branches coverage does NOT additionally fail it. ---
{
    const tier = new Set([`${TASK}/src/critical.js`]);
    const { failures, oks } = run([f('src/critical.js', 75, 15, 20, 5, 5)], ex('src/critical.js', 70), tier);
    check(
        'tiered EXCEPTIONS file is not additionally failed on functions/branches',
        failures.length === 0 && oks.some((x) => x.startsWith('exempt') && x.includes('critical.js')),
        { failures, oks },
    );
}

// --- Case 13: the live EXCEPTIONS map is well-formed. ---
{
    const entries = Object.entries(EXCEPTIONS);
    const wellFormed = entries.length > 0 && entries.every(([k, v]) =>
        /^Tasks\/[^/]+\/[^/]+\/src\/.+\.js$/.test(k)
        && typeof v.floor === 'number' && v.floor >= 0 && v.floor < (SECURITY_TIER.has(k) ? SECURITY_FLOOR : DEFAULT_FLOOR)
        && typeof v.note === 'string' && v.note.length > 0);
    check('live EXCEPTIONS entries are well-formed (task-scoped .js path, floor below its applicable tier, has note)', wellFormed, EXCEPTIONS);
}

// --- Case 14: the live SECURITY_TIER set is well-formed (task-scoped .js
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
