#!/usr/bin/env node
// Self-test for check-per-file-coverage.js: exercises the REAL exported
// evaluate() (no mocks of the subject) across every branch — pass, a
// non-exception file below the floor, an exception file below its own floor, a
// stale exception that now clears the default floor, a dangling exception whose
// file vanished, and the exempt-in-range case — plus a sanity check that the
// live EXCEPTIONS map is well-formed. A silent bug here would let a fully
// unexercised module slip under the per-file gate that issue #590 added.

const { evaluate, DEFAULT_FLOOR, EXCEPTIONS } = require('./check-per-file-coverage.js');

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

// --- Case 1: everything above the default floor, no exceptions -> no failures. ---
{
    const { failures } = evaluate({ taskRel: TASK, files: [f('src/a.js', 95), f('src/b.js', 61)], defaultFloor: DEFAULT_FLOOR, exceptions: {} });
    check('clean tree yields no failures', failures.length === 0, failures);
}

// --- Case 2: a non-exception file below the floor -> one floor failure. ---
{
    const { failures } = evaluate({ taskRel: TASK, files: [f('src/a.js', 95), f('src/thin.js', 10, 3, 30)], defaultFloor: DEFAULT_FLOOR, exceptions: {} });
    check(
        'non-exception file below floor fails',
        failures.length === 1 && failures[0].includes('thin.js') && failures[0].includes(`${DEFAULT_FLOOR}% per-file floor`),
        failures,
    );
}

// --- Case 3: an exception file below its OWN floor -> failure. ---
{
    const { failures } = evaluate({ taskRel: TASK, files: [f('src/legacy.js', 5, 1, 20)], defaultFloor: DEFAULT_FLOOR, exceptions: ex('src/legacy.js', 20) });
    check(
        'exception file below its own floor fails',
        failures.length === 1 && failures[0].includes('legacy.js') && failures[0].includes('exception floor 20%'),
        failures,
    );
}

// --- Case 4: a stale exception (now clears the default floor) -> failure. ---
{
    const { failures } = evaluate({ taskRel: TASK, files: [f('src/legacy.js', 91, 20, 22)], defaultFloor: DEFAULT_FLOOR, exceptions: ex('src/legacy.js', 20) });
    check(
        'stale exception (now above default floor) fails and asks for removal',
        failures.length === 1 && failures[0].includes('legacy.js') && failures[0].includes('stale entry'),
        failures,
    );
}

// --- Case 5: a dangling exception whose file is absent -> failure. ---
{
    const { failures } = evaluate({ taskRel: TASK, files: [f('src/a.js', 95)], defaultFloor: DEFAULT_FLOOR, exceptions: ex('src/legacy.js', 20) });
    check(
        'dangling exception (file absent) fails',
        failures.length === 1 && failures[0].includes('dangling entry'),
        failures,
    );
}

// --- Case 6: exception file within [floor, defaultFloor) -> exempt, no failure. ---
{
    const { failures, oks } = evaluate({ taskRel: TASK, files: [f('src/legacy.js', 24, 8, 34)], defaultFloor: DEFAULT_FLOOR, exceptions: ex('src/legacy.js', 20) });
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
    const { failures } = evaluate({ taskRel: TASK, files: [f('src/a.js', 95), f('src/legacy.js', 24, 8, 34)], defaultFloor: DEFAULT_FLOOR, exceptions });
    check('other-task exceptions are neither enforced nor reported dangling here', failures.length === 0, failures);
}

// --- Case 8: the live EXCEPTIONS map is well-formed. ---
{
    const entries = Object.entries(EXCEPTIONS);
    const wellFormed = entries.length > 0 && entries.every(([k, v]) =>
        /^Tasks\/[^/]+\/[^/]+\/src\/.+\.js$/.test(k)
        && typeof v.floor === 'number' && v.floor >= 0 && v.floor < DEFAULT_FLOOR
        && typeof v.note === 'string' && v.note.length > 0);
    check('live EXCEPTIONS entries are well-formed (task-scoped .js path, 0 <= floor < default, has note)', wellFormed, EXCEPTIONS);
}

if (failed) {
    console.error('\ncheck-per-file-coverage.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-per-file-coverage.js self-test: all cases passed.');
