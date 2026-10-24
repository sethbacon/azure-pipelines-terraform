#!/usr/bin/env node
// Node20_1 handler smoke gate: runs a task's COMPILED entry point (src/index.js)
// with no task inputs, under whichever Node is running this script, and fails
// unless the run ended inside the task's OWN error handling.
//
// WHY THE EXIT CODE IS NOT ENOUGH. azure-pipelines-task-lib registers a
// process-wide 'uncaughtException' listener the moment it is imported
// (task.js). The listener records the error with setResult as `Unhandled:
// <message>` and returns, so Node does not exit non-zero. Every index.ts here
// imports task-lib first, so any LATER top-level import that throws -- a
// dependency that does not load on this Node, say -- ends the run with exit
// code 0. That is how undici 8, which cannot load on Node 20, passed
// `node src/index.js` in azure-pipelines-packer's Build and Test jobs while
// both of its tasks were unusable on the Node20_1 handler. Every Node 20 smoke
// step in this repository had the same blind spot.
//
// WHAT PASSES. With no INPUT_* variables a task's run() reaches its own
// try/catch and records a caught Failed result, usually "Input required:
// <name>". This script requires all three of:
//   - exit code 0 (a crash before task-lib loads still exits non-zero);
//   - at least one ##vso[task.complete ...] line, so the task recorded a result;
//   - no recorded result that came from an uncaught path: task-lib's
//     LIB_UnhandledEx (read from the installed task-lib's lib.json, not copied
//     here) or the tasks' own `Uncaught exception:` / `Unhandled rejection:`
//     handlers in index.ts.
//
// Usage: node scripts/smoke-compiled-task.js [taskDir]   (default: cwd)
// Self-test: scripts/test-smoke-compiled-task.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const taskDir = path.resolve(process.argv[2] || process.cwd());
const entry = path.join(taskDir, 'src', 'index.js');

function fail(message) {
    console.error(`smoke-compiled-task: ${message}`);
    process.exit(1);
}

if (!fs.existsSync(entry)) {
    fail(`no compiled entry point at ${entry}. Compile the task first.`);
}

let unhandledTemplate;
try {
    const libJson = require.resolve('azure-pipelines-task-lib/lib.json', { paths: [taskDir] });
    unhandledTemplate = JSON.parse(fs.readFileSync(libJson, 'utf8')).messages.LIB_UnhandledEx;
} catch (err) {
    fail(`cannot read LIB_UnhandledEx from azure-pipelines-task-lib/lib.json under ${taskDir}: ${err.message}`);
}
if (typeof unhandledTemplate !== 'string' || !unhandledTemplate.includes('%s')) {
    fail(`azure-pipelines-task-lib's LIB_UnhandledEx is ${JSON.stringify(unhandledTemplate)}, not a "%s" template`);
}
const UNCAUGHT_PREFIXES = [
    unhandledTemplate.slice(0, unhandledTemplate.indexOf('%s')),
    'Uncaught exception:',
    'Unhandled rejection:',
];

const run = spawnSync(process.execPath, [entry], { cwd: taskDir, encoding: 'utf8', timeout: 120000 });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');

if (run.error) {
    fail(`could not run ${entry}: ${run.error.message}`);
}
if (run.status !== 0) {
    fail(`${entry} exited ${run.status === null ? `on ${run.signal}` : run.status} under Node ${process.version}.`);
}

const results = [...String(run.stdout).matchAll(/^##vso\[task\.complete result=([^;\]]*);?\](.*?)\r?$/gm)]
    .map(([, result, message]) => ({ result, message }));
if (results.length === 0) {
    fail(`${entry} exited 0 under Node ${process.version} without recording a task result.`);
}
const uncaught = results.find(({ message }) => UNCAUGHT_PREFIXES.some((prefix) => message.startsWith(prefix)));
if (uncaught) {
    fail(`under Node ${process.version}, ${entry} failed outside its own error handling ("${uncaught.message}"). ` +
        'The exit code was 0 only because azure-pipelines-task-lib or the task caught it at process level.');
}

const last = results[results.length - 1];
console.log(`OK: under Node ${process.version} the compiled task loaded and ended in its own error handling (${last.result}: ${last.message}).`);
