#!/usr/bin/env node
// Self-test for smoke-compiled-task.js: proves the Node20_1 smoke gate fails a
// task whose run ended OUTSIDE its own error handling, even when the process
// exits 0, and still passes the caught "Input required" failure every task
// produces when it runs with no inputs.
//
// The row that matters is "swallowed load failure". Its output is what
// azure-pipelines-packer's compiled PackerTaskV1 printed under Node 20 while it
// shipped undici 8, which does not load there: azure-pipelines-task-lib's
// uncaughtException listener recorded `Unhandled: ...` and the process exited
// 0, so `node src/index.js` passed that repository's smoke step in every job.
//
// Each row builds a throwaway task directory holding a stub src/index.js and
// the one file the gate reads from azure-pipelines-task-lib (lib.json; a row
// sets `libJson: null` to leave task-lib out), runs
// the real smoke-compiled-task.js against it via spawnSync, and checks the exit
// code. The scratch dir is removed afterwards either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, 'smoke-compiled-task.js');
const LIB_JSON = JSON.stringify({ messages: { LIB_UnhandledEx: 'Unhandled: %s' } });

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-compiled-task-selftest-'));
let failed = false;

function taskDir(name, { indexJs, libJson = LIB_JSON }) {
    const dir = path.join(scratchDir, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    if (indexJs !== undefined) {
        fs.writeFileSync(path.join(dir, 'src', 'index.js'), indexJs);
    }
    if (libJson !== null) {
        const lib = path.join(dir, 'node_modules', 'azure-pipelines-task-lib');
        fs.mkdirSync(lib, { recursive: true });
        fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: 'azure-pipelines-task-lib', version: '0.0.0' }));
        fs.writeFileSync(path.join(lib, 'lib.json'), libJson);
    }
    return dir;
}

// Writes `line` the way task-lib's setResult does, then exits with `code`.
function emits(line, code = 0) {
    return `process.stdout.write(${JSON.stringify(line + os.EOL)});\nprocess.exitCode = ${code};\n`;
}

// `expect` is 'pass', or a fragment of the gate's own failure message. Matching
// the reason, not just a non-zero exit, is what makes each guard mutation-proven:
// several of them would otherwise be covered by a later guard, or by the gate
// crashing, and could be deleted with every row still green.
const OUTSIDE = 'failed outside its own error handling';
const ROWS = [
    {
        name: 'caught input failure passes',
        indexJs: emits('##vso[task.complete result=Failed;]Input required: command'),
        expect: 'pass',
    },
    {
        name: 'caught failure with task-specific wording passes',
        indexJs: emits('##vso[task.complete result=Failed;]ServiceNow instance is required (set "instance" input or provide a service connection).'),
        expect: 'pass',
    },
    {
        name: 'swallowed load failure fails although the exit code is 0',
        indexJs: emits("##vso[task.complete result=Failed;]Unhandled: Cannot read properties of undefined (reading 'bind')"),
        expect: OUTSIDE,
    },
    {
        name: 'the Unhandled prefix is read from lib.json, not hard-coded',
        indexJs: emits('##vso[task.complete result=Failed;]Non gestito: boom'),
        libJson: JSON.stringify({ messages: { LIB_UnhandledEx: 'Non gestito: %s' } }),
        expect: OUTSIDE,
    },
    {
        name: "the task's own unhandledRejection handler fails even at exit 0",
        indexJs: emits('##vso[task.complete result=Failed;]Unhandled rejection: boom'),
        expect: OUTSIDE,
    },
    {
        name: "the task's own uncaughtException handler fails even at exit 0",
        indexJs: emits('##vso[task.complete result=Failed;]Uncaught exception: boom'),
        expect: OUTSIDE,
    },
    {
        name: 'an earlier uncaught result is not masked by a later caught one',
        indexJs: emits('##vso[task.complete result=Failed;]Unhandled: boom\n##vso[task.complete result=Failed;]Input required: command'),
        expect: OUTSIDE,
    },
    {
        name: 'a caught result followed by a non-zero exit fails',
        indexJs: emits('##vso[task.complete result=Failed;]Input required: command', 1),
        expect: 'exited 1',
    },
    {
        name: 'a crash before task-lib loads fails',
        indexJs: "throw new SyntaxError('Unexpected token');\n",
        expect: 'exited 1',
    },
    {
        name: 'a run that records no result fails',
        indexJs: emits('nothing to see here'),
        expect: 'without recording a task result',
    },
    {
        name: 'a missing compiled entry point fails',
        indexJs: undefined,
        expect: 'no compiled entry point',
    },
    {
        name: 'a task-lib whose LIB_UnhandledEx is not a %s template fails',
        indexJs: emits('##vso[task.complete result=Failed;]Input required: command'),
        libJson: JSON.stringify({ messages: {} }),
        expect: 'not a "%s" template',
    },
    {
        name: 'a task without azure-pipelines-task-lib fails',
        indexJs: emits('##vso[task.complete result=Failed;]Input required: command'),
        libJson: null,
        expect: 'cannot read LIB_UnhandledEx',
    },
];

try {
    for (const row of ROWS) {
        const dir = taskDir(row.name.replace(/[^a-z0-9]+/gi, '-'), row);
        const run = spawnSync(process.execPath, [scriptPath, dir], { encoding: 'utf8' });
        if (run.error) {
            throw run.error;
        }
        const stderr = String(run.stderr);
        const ok = row.expect === 'pass'
            ? run.status === 0
            : run.status === 1 && stderr.includes(`smoke-compiled-task: `) && stderr.includes(row.expect);
        if (ok) {
            console.log(`ok   - ${row.name}`);
        } else {
            failed = true;
            console.error(`FAIL - ${row.name}: expected ${row.expect === 'pass' ? 'a pass' : `a failure naming "${row.expect}"`}, gate exited ${run.status}`);
            console.error(String(run.stdout) + stderr);
        }
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    process.exit(1);
}
console.log(`smoke-compiled-task self-test passed (${ROWS.length} rows).`);
