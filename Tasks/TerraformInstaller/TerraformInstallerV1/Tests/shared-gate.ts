// @shared-module: copied from azure-pipelines-packer (Tasks/PackerTask/PackerTaskV1/Tests/shared-gate.ts)
// @shared-module-policy: fixes land in azure-pipelines-packer first and are copied here; within this repository
//   scripts/check-shared-modules.js byte-compares every copy against the canonical one.
// @shared-module-status: IN-SYNC
//
// Finds a gate this repository no longer carries.
//
// The four ADO-extension class gates live in 4cloudguru/shared-workflows as composite
// actions. CI runs each as a STEP, pinned by SHA; the runner materialises the action
// tree at that SHA and the composite writes its own `github.action_path` into
// $GITHUB_ENV for the steps after it. So on a runner the gate this file returns IS the
// gate the `uses:` pin names — not by convention, by construction.
//
// Every branch below either returns a path or throws. There is deliberately no branch
// that returns undefined and none that skips: the assertions that call this are the only
// thing enumerating their defect class inside `npm test`, so a could-not-run that read
// like a clean run would be the exact failure this estate keeps re-learning. Every task's
// mocha invocation also carries `--forbid-pending` (see package.json), so even a future
// edit that tried to `this.skip()` around a missing gate would fail the run — a second,
// independent lock on the same property.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const announced = new Set<string>();

function announce(gate: string, how: string): string {
    if (!announced.has(gate)) {
        announced.add(gate);
        const sha = crypto.createHash('sha256').update(fs.readFileSync(gate)).digest('hex').slice(0, 16);
        // Which bytes ran, in the log, once. A developer's sibling checkout sits at
        // whatever ref that clone is on; this is what makes that visible rather than
        // silent, and it is the anchor for the mutation check in every consumer PR.
        console.log(`[shared-gate] ${path.basename(gate)} sha256:${sha} <- ${gate} (via ${how})`);
    }
    return gate;
}

const missingFrom = (dir: string, file: string, requires: string[]): string[] =>
    [file, ...requires].filter((rel) => !fs.existsSync(path.join(dir, rel)));

/**
 * @param repoRoot  the consumer repository root (the L0 files' REPO_ROOT)
 * @param action    the composite action directory name, e.g. 'check-proxy-parity'
 * @param file      the gate's entry point inside it
 * @param requires  files the gate needs BESIDE itself — the same set gatelib's
 *                  SHARED_ACTION_ASSETS records, for the same reason: a gate shipped
 *                  without them is a script that cannot start, and node's
 *                  MODULE_NOT_FOUND exits 1, which is also this gate's "found a defect".
 */
export function sharedGate(repoRoot: string, action: string, file: string, requires: string[] = []): string {
    const env = 'SHARED_GATE_' + action.toUpperCase().replace(/-/g, '_');
    const fromCI = process.env[env];

    if (fromCI) {
        // Shape before contents: a value pointing at the WRONG action's directory must
        // not be reported as an incomplete upstream action. (Getting these two the other
        // way round is a real mistake — ci-path's prototype had it until [X-9].)
        // path.basename here is the platform's own: on windows-2025 it is path.win32's,
        // which returns 'check-proxy-parity' for a `D:\a\_actions\...` value.
        if (path.basename(fromCI.replace(/[\\/]+$/, '')) !== action) {
            throw new Error(
                `${env} points at '${fromCI}', whose last path segment is not '${action}'. On a runner ` +
                `this variable is written by the '${action}' composite from github.action_path, so a value ` +
                `shaped like anything else was set by something other than that action — which is not the ` +
                `gate the uses: pin names.`);
        }
        const missing = missingFrom(fromCI, file, requires);
        if (missing.length) {
            throw new Error(
                `${env} points at '${fromCI}', which does not carry ${missing.join(', ')}. That directory is ` +
                `materialised by the '${action}' composite action at the SHA .github/workflows pins, so this ` +
                `is an incomplete action, not a missing checkout: the class this repository's CI believes it ` +
                `is running is running nowhere. Fix it in ` +
                `4cloudguru/shared-workflows/.github/actions/${action}/ and roll the pin.`);
        }
        return announce(path.join(fromCI, file), env);
    }

    if (process.env.GITHUB_ACTIONS === 'true') {
        throw new Error(
            `${env} is not set. On a runner this gate comes from the '${action}' composite action, which ` +
            `exports ${env} into $GITHUB_ENV for the steps after it. Add ` +
            `\`- uses: 4cloudguru/shared-workflows/.github/actions/${action}@<sha>\` to this job BEFORE the ` +
            `step that runs npm test, at the same SHA the rest of this repository pins. There is deliberately ` +
            `no fallback here: a test that found the gate some other way on a runner would not be running the ` +
            `bytes the pin names.`);
    }

    const sibling = path.resolve(repoRoot, '..', 'shared-workflows', '.github', 'actions', action);
    const missing = missingFrom(sibling, file, requires);
    if (!missing.length) return announce(path.join(sibling, file), 'sibling checkout');

    throw new Error(
        `cannot find the '${action}' gate. This repository no longer carries a copy: the gate lives in ` +
        `4cloudguru/shared-workflows and CI runs it as a composite action pinned by SHA.\n` +
        `  Looked for : ${path.join(sibling, file)}\n` +
        `  Missing    : ${missing.join(', ')}\n` +
        `To run the suite locally, check the repository out beside this one:\n` +
        `  git clone https://github.com/4cloudguru/shared-workflows ${path.resolve(repoRoot, '..', 'shared-workflows')}\n` +
        `That is the same sibling-checkout convention CONTRIBUTING.md already documents for check-docs-claims ` +
        `and check-shared-module-pins. Alternatively point ${env} at a .github/actions/${action} directory you ` +
        `have already checked out. This is a hard error and not a skipped test on purpose: the assertions below ` +
        `are the only thing that enumerates this defect class, so "could not run" must never read like "clean".`);
}
