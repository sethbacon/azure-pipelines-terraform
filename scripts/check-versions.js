#!/usr/bin/env node
// Validates that version fields exist and are well-formed in all task manifests.
//
// The task list is DERIVED from the Tasks/*/*/task.json directory scan (see
// scripts/lib/task-dirs.js), not hand-maintained here, so a newly added task is
// validated automatically and can never be silently omitted (issue #502). The
// extension manifest is the one fixed, non-task entry.

const fs = require('fs');
const path = require('path');
const { discoverTaskDirs } = require('./lib/task-dirs.js');

const files = [
    { path: 'azure-devops-extension.json', type: 'extension' },
    ...discoverTaskDirs(process.cwd()).map((dir) => ({ path: `${dir}/task.json`, type: 'task' })),
];

let hasError = false;

for (const file of files) {
    const fullPath = path.resolve(file.path);
    if (!fs.existsSync(fullPath)) {
        console.error(`FAIL: ${file.path} does not exist`);
        hasError = true;
        continue;
    }

    const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

    if (file.type === 'extension') {
        const version = json.version;
        if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
            console.error(`FAIL: ${file.path} has invalid version: ${version}`);
            hasError = true;
        } else {
            console.log(`OK: ${file.path} version=${version}`);
        }
    } else {
        const v = json.version;
        if (!v || !v.Major || !v.Minor || v.Patch === undefined) {
            console.error(`FAIL: ${file.path} has missing version fields`);
            hasError = true;
        } else {
            console.log(`OK: ${file.path} version=${v.Major}.${v.Minor}.${v.Patch}`);
        }
    }
}

// --- Localized-message resolution gate (#201, sibling azure-pipelines-packer #201) ---
//
// azure-pipelines-task-lib loads resources by iterating task.json's `messages`
// map (`for (var key in resourceJson.messages)` in its internal.js) and consults
// Strings/resources.resjson only as a per-culture OVERRIDE for keys already
// listed there. A key that exists ONLY in the resjson is therefore never loaded:
// tasks.loc() warns "Can't find loc string for key: ..." and returns the raw
// `KeyName arg1 arg2` text. A guard whose rejection renders as its own key name
// still fails closed, but its diagnostics are gone -- and nothing was watching.
//
// This gate makes that unrepresentable: every key a source file actually passes
// to tasks.loc() (directly, or through a repo-local helper that forwards a key
// parameter to tasks.loc -- e.g. TerraformTaskV5's throwCommandFailure), and
// every key the resjson declares, must appear in task.json's `messages`. The
// reverse (a task.json key with no resjson entry) is benign: task.json carries
// the en-US text itself, and the resjson only adds per-culture overrides.

function collectTsFiles(dir, out = []) {
    if (!fs.existsSync(dir)) {
        return out;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTsFiles(full, out);
        } else if (entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

const LOC_CALL_PATTERN = /\bloc\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;

/**
 * Finds repo-local helpers that forward a KEY PARAMETER to tasks.loc(), so a
 * call like throwCommandFailure("TerraformFmtFailed", code) is recognized as a
 * loc-key use. Returns a Map of helperName -> argument index of the key.
 */
function findLocKeyHelpers(sources) {
    const helpers = new Map();
    for (const source of sources) {
        const re = /(?:function|private|protected|public)\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g;
        let m;
        while ((m = re.exec(source)) !== null) {
            const [name, paramText] = [m[1], m[2]];
            const params = paramText.split(',').map((p) => p.trim().split(':')[0].trim()).filter(Boolean);
            const body = source.slice(m.index, m.index + 1200);
            for (let i = 0; i < params.length; i++) {
                if (new RegExp(`\\bloc\\(\\s*${params[i]}\\b`).test(body)) {
                    helpers.set(name, i);
                }
            }
        }
    }
    return helpers;
}

for (const file of files.filter((f) => f.type === 'task')) {
    const taskDir = path.dirname(path.resolve(file.path));
    const taskJson = JSON.parse(fs.readFileSync(path.resolve(file.path), 'utf8'));
    const declared = new Set(Object.keys(taskJson.messages || {}));

    const tsFiles = collectTsFiles(path.join(taskDir, 'src'));
    const sources = tsFiles.map((f) => fs.readFileSync(f, 'utf8'));
    const helpers = findLocKeyHelpers(sources);

    // 1. Every loc-key use must have a task.json message.
    const used = new Map(); // key -> first file that uses it
    tsFiles.forEach((tsFile, i) => {
        const source = sources[i];
        const rel = path.relative(taskDir, tsFile);
        for (const match of source.matchAll(LOC_CALL_PATTERN)) {
            if (!used.has(match[1])) used.set(match[1], rel);
        }
        for (const [helper, argIndex] of helpers) {
            const re = new RegExp(`\\b${helper}\\(((?:[^();]|\\([^()]*\\)){0,200})\\)`, 'g');
            let m;
            while ((m = re.exec(source)) !== null) {
                const arg = (m[1].split(',')[argIndex] || '').trim();
                const literal = arg.match(/^["'`]([A-Za-z0-9_]+)["'`]$/);
                if (literal && !used.has(literal[1])) used.set(literal[1], rel);
            }
        }
    });
    for (const [key, where] of used) {
        if (!declared.has(key)) {
            console.error(`FAIL: ${file.path} messages is missing '${key}', used as a loc key in ${where}`);
            console.error(`      task-lib only loads keys listed in task.json's messages map, so this would render as raw text.`);
            hasError = true;
        }
    }

    // 2. Every resjson loc.messages.* key must have a task.json message, with the
    //    same en-US text (the resjson is an override, not a separate source).
    const resjsonPath = path.join(taskDir, 'Strings/resources.resjson/en-US/resources.resjson');
    if (fs.existsSync(resjsonPath)) {
        const resjson = JSON.parse(fs.readFileSync(resjsonPath, 'utf8'));
        for (const key of Object.keys(resjson)) {
            if (!key.startsWith('loc.messages.')) continue;
            const messageKey = key.slice('loc.messages.'.length);
            if (!declared.has(messageKey)) {
                console.error(`FAIL: ${file.path} messages is missing '${messageKey}', declared in ${path.relative(taskDir, resjsonPath)}`);
                console.error(`      a resjson-only key is never loaded by task-lib; add it to task.json's messages map too.`);
                hasError = true;
            } else if (resjson[key] !== taskJson.messages[messageKey]) {
                // Text drift between the two en-US copies is a cosmetic
                // inconsistency, not the #201 defect (the key still LOADS, from
                // task.json). Reported so it is visible, but it does not fail
                // the gate -- changing shipped log text is a separate decision.
                console.warn(`WARN: ${file.path} message '${messageKey}' text differs from the en-US resjson entry`);
            }
        }
    }

    console.log(`OK: ${file.path} loc messages resolve (${used.size} call-site key(s), ${declared.size} declared)`);
}

if (hasError) {
    process.exit(1);
}
console.log('All version checks passed.');
