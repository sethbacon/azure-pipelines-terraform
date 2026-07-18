#!/usr/bin/env node
// Runs one build command across every task package, deriving the task list from
// the Tasks/*/*/task.json directory scan (scripts/lib/task-dirs.js) rather than
// the ~33 hand-maintained per-task npm-script lines this replaced (issue #502).
// A newly added task is picked up automatically; there is nothing per-task to
// forget, so no cross-check is needed for these commands anymore.
//
// Usage: node scripts/for-each-task.js <ci|prune|compile>
//   ci      -> npm ci in each task (mirrors the old deps:npm:* scripts)
//   prune   -> npm prune --omit=dev in each task (old deps:prune:* scripts)
//   compile -> tsc -b each task's tsconfig.json (old compile:* scripts)
//
// Invoked by the root package.json `deps` / `deps:prune` / `compile` scripts —
// the stable, by-name entry points that build:release (and thus release CI) call.

const path = require('path');
const { execSync } = require('child_process');
const { discoverTaskDirs } = require('./lib/task-dirs.js');

const repoRoot = path.resolve(__dirname, '..');

const COMMANDS = {
    ci: (task) => `npm --prefix ${task} ci --ignore-scripts --no-update-notifier --no-progress`,
    prune: (task) => `npm --prefix ${task} prune --omit=dev --no-update-notifier --no-progress`,
    compile: (task) => `tsc -b ${task}/tsconfig.json`,
};

function main() {
    const cmd = process.argv[2];
    if (!cmd || !COMMANDS[cmd]) {
        console.error(
            `for-each-task: unknown command '${cmd || ''}'. Expected one of: ${Object.keys(COMMANDS).join(', ')}.`,
        );
        process.exit(2);
    }

    const tasks = discoverTaskDirs(repoRoot);
    if (tasks.length === 0) {
        console.error('for-each-task: no task directories found under Tasks/.');
        process.exit(1);
    }

    // Each task path is interpolated into a shell command below, so refuse
    // anything that isn't the expected Tasks/<Family>/<Version> shape with a
    // conservative character set — making shell metacharacter injection via a
    // hostile directory name structurally impossible, even though these names
    // come from the repo's own tree rather than external input.
    const SAFE_TASK = /^Tasks\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
    for (const task of tasks) {
        if (!SAFE_TASK.test(task)) {
            console.error(`for-each-task: refusing unsafe task path '${task}'.`);
            process.exit(1);
        }
    }

    // Ensure the repo-root node_modules/.bin (where tsc lives) is on PATH even
    // when this script is invoked directly rather than via `npm run`, which
    // already prepends it. Windows uses a case-insensitive PATH var name.
    const binDir = path.join(repoRoot, 'node_modules', '.bin');
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${binDir}${path.delimiter}${env[pathKey] || ''}`;

    for (const task of tasks) {
        const line = COMMANDS[cmd](task);
        console.log(`\n> for-each-task ${cmd}: ${task}`);
        try {
            execSync(line, { cwd: repoRoot, stdio: 'inherit', env });
        } catch (err) {
            process.exit(typeof err.status === 'number' ? err.status : 1);
        }
    }
}

main();
