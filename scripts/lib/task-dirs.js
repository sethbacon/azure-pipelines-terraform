// Single source of truth for "what are the task directories?".
//
// The repo used to hand-maintain the 11-task list in several places
// (check-versions.js, check-minor-bumps.js, package.json script families) and
// rely on check-task-list.js to catch drift after the fact. Those consumers now
// DERIVE the list from disk via this module instead, so a new task is picked up
// automatically and cannot be forgotten (issue #502). The remaining
// hand-maintained surfaces that carry per-task metadata which cannot be derived
// (azure-devops-extension.json contributions, release.yml SBOM steps,
// dependabot.yml entries) are still cross-checked against this same scan by
// check-task-list.js.
//
// Ground truth: every immediate subdirectory of Tasks/<Family>/ that contains a
// task.json, returned as sorted repo-relative 'Tasks/<Family>/<Version>' paths.

const fs = require('fs');
const path = require('path');

// `root` is the repo root to scan (the directory that contains Tasks/). Callers
// pass process.cwd() when they operate relative to the invocation directory
// (check-versions.js, check-minor-bumps.js — mirroring their git/fs calls) or
// their own resolved repo root (check-task-list.js).
function discoverTaskDirs(root) {
    const dirs = [];
    const familyRoot = path.join(root, 'Tasks');
    if (!fs.existsSync(familyRoot)) {
        return dirs;
    }
    for (const family of fs.readdirSync(familyRoot, { withFileTypes: true })) {
        if (!family.isDirectory()) continue;
        const familyPath = path.join(familyRoot, family.name);
        for (const version of fs.readdirSync(familyPath, { withFileTypes: true })) {
            if (!version.isDirectory()) continue;
            const taskJson = path.join(familyPath, version.name, 'task.json');
            if (fs.existsSync(taskJson)) {
                dirs.push(`Tasks/${family.name}/${version.name}`);
            }
        }
    }
    return dirs.sort();
}

module.exports = { discoverTaskDirs };
