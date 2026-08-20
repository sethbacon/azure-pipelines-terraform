#!/usr/bin/env node
// Publishes the packaged .vsix to the VS Marketplace via tfx-cli, with the two
// release-pipeline disciplines that were previously only comments in
// release.yml enforced by construction:
//
//   1. THE TOKEN NEVER TOUCHES argv. tfx is spawned with --auth-type pat and NO
//      --token, so it prompts for the token on stdin; the minted Entra access
//      token is written to that stdin pipe. `::add-mask::` only redacts log
//      output -- a token on argv is readable in /proc/<pid>/cmdline by anything
//      else running in the job for the lifetime of the process (CWE-214, #109).
//
//   2. A TRANSIENT UPSTREAM FAILURE DOES NOT BURN THE RELEASE. v1.2.7's publish
//      died on a single HTTP 503 from the Marketplace; with no retry the release
//      job failed and left an orphaned draft GitHub Release behind. Retries are
//      bounded and classify the failure: only transport/5xx/429 output is
//      retried, never a deterministic rejection (bad manifest, auth failure,
//      duplicate version), so a genuine error still fails fast.
//
//      Retrying a publish is only safe because of the "already published"
//      handling below: if attempt N actually reached the Marketplace but the
//      response was lost, attempt N+1 sees "already exists" and completes
//      successfully rather than failing the release a second time. That check is
//      deliberately gated on attempt >= 2, so publishing a version that really
//      was already published still fails on a first attempt.
//
// This runs INSIDE the `marketplace` environment job; it does not change, skip
// or weaken that environment's required-reviewer approval or its deployment
// branch/ref policy -- those gate the job, and this is a step within it.
//
// Usage: node scripts/publish-marketplace.js --vsix <file> [--tfx <path>]
//   MARKETPLACE_TOKEN       (required) the token to feed tfx on stdin
//   PUBLISH_MAX_ATTEMPTS    default 4
//   PUBLISH_RETRY_BASE_MS   default 5000 (exponential: base * 2^(attempt-1))

const { spawn } = require('child_process');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

const vsix = arg('--vsix');
const tfx = arg('--tfx') || './node_modules/.bin/tfx';
const token = process.env.MARKETPLACE_TOKEN;
const maxAttempts = parseInt(process.env.PUBLISH_MAX_ATTEMPTS || '4', 10);
const baseDelayMs = parseInt(process.env.PUBLISH_RETRY_BASE_MS || '5000', 10);

// Transient: worth another attempt. Status codes are matched with explicit
// non-digit boundaries so a version string like "1.503.0" cannot look like a 503.
const TRANSIENT = /(?:^|[^\d.])(?:429|500|502|503|504)(?![\d.])|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error|TooManyRequests|Too Many Requests|request timed out|network (?:error|timeout)/i;

// The version is already on the Marketplace.
//
// The first three alternatives were written against error strings tfx does NOT
// emit for a duplicate version. What it actually says is:
//
//   error: Version number must increase each time an extension is published.
//     Extension: <publisher>.<id>  Current version: X  Updated version: X
//
// which matched none of them -- so the "retrying a publish is only safe because
// of the already-published handling" claim in the header was, until now, false:
// the handling existed and could never fire for the error it was written for.
// Found when v1.14.4's release was re-run (2026-08-20). The older patterns are
// kept because tfx has used them for other duplicate shapes.
const ALREADY_PUBLISHED = /already exists|already been published|already published|version .{0,40}\bexists\b|Version number must increase/i;

// tfx uploaded the extension, then gave up WAITING for Marketplace validation:
//
//   error: Validation is taking much longer than usual. TFX is exiting. To get
//   the validation status, you may run the command below. This extension will
//   be available after validation is successful.
//
// This is not a failure. The upload landed -- v1.14.4 went live at 15:14 while
// tfx exited 255 at 15:15 -- but exit 255 was read as a non-retryable error,
// which failed the job, SKIPPED the undraft step, and left the release stranded
// in draft while the extension was public. Worse, it poisoned the retry path:
// re-running then hits the duplicate-version error above, so the recovery route
// is guaranteed to fail with an error that looks like an unrelated second bug.
const VALIDATION_PENDING = /Validation is taking much longer than usual|extension will be available after validation/i;

// tfx prints the exact isvalid invocation in that message, parameters included.
// Parsing them is how this script asks the Marketplace what is actually true
// rather than inferring an outcome from an exit code.
const ISVALID_HINT = /--publisher\s+(\S+)[\s\S]*?--extension-id\s+(\S+)[\s\S]*?--version\s+(\S+)/;
// The duplicate message names the extension and both versions.
const DUPLICATE_DETAIL = /Extension:\s*(\S+)\s+Current version:\s*(\S+)\s+Updated version:\s*(\S+)/i;

function fail(message) {
    console.error(`publish-marketplace: ${message}`);
    process.exit(1);
}

if (!vsix) fail('missing --vsix <file>');
if (!token) fail('MARKETPLACE_TOKEN is not set (the token is supplied via the environment and forwarded on stdin, never on argv)');
if (!Number.isInteger(maxAttempts) || maxAttempts < 1) fail(`PUBLISH_MAX_ATTEMPTS must be a positive integer, got '${process.env.PUBLISH_MAX_ATTEMPTS}'`);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One tfx publish attempt. Resolves { code, output } — output is the combined
 * stdout+stderr, which is also streamed through to this process's own streams so
 * the job log still shows tfx's progress live.
 */
function publishOnce() {
    return new Promise((resolve, reject) => {
        // No --token here, by design: tfx-cli prompts for it on stdin when
        // --auth-type pat is given without one.
        const child = spawn(tfx, ['extension', 'publish', '--vsix', vsix, '--auth-type', 'pat'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
        child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code === null ? 1 : code, output }));
        child.stdin.on('error', () => { /* tfx may exit before reading stdin; the close handler decides the outcome */ });
        child.stdin.end(`${token}\n`);
    });
}

/**
 * Ask the Marketplace whether a version is actually there and valid.
 *
 * This exists so the two ambiguous outcomes below are resolved by EVIDENCE
 * rather than by a counter. The previous design inferred "a previous attempt
 * must have succeeded" from `attempt > 1`, which is only true within one
 * process -- a workflow-level re-run starts a fresh process at attempt 1, so
 * the safety net could never fire for the case that needs it most.
 *
 * Resolves 'valid' | 'invalid' | 'unknown'. 'unknown' means the check itself
 * could not answer, which is deliberately NOT treated as either outcome.
 */
function isPublishedAndValid({ publisher, extensionId, version }) {
    return new Promise((resolve) => {
        if (!publisher || !extensionId || !version) return resolve('unknown');
        const child = spawn(tfx, [
            'extension', 'isvalid',
            '--publisher', publisher,
            '--extension-id', extensionId,
            '--version', version,
            '--auth-type', 'pat',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
        child.stderr.on('data', (c) => { out += c; process.stderr.write(c); });
        child.on('error', () => resolve('unknown'));
        child.on('close', (code) => {
            if (code === 0) return resolve(/\binvalid\b|validation failed/i.test(out) ? 'invalid' : 'valid');
            if (/\binvalid\b|validation failed/i.test(out)) return resolve('invalid');
            resolve('unknown');
        });
        child.stdin.on('error', () => {});
        child.stdin.end(`${token}\n`);
    });
}

async function main() {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`publish-marketplace: attempt ${attempt}/${maxAttempts}`);
        const { code, output } = await publishOnce();

        if (code === 0) {
            console.log(`publish-marketplace: published on attempt ${attempt}.`);
            return 0;
        }

        // Uploaded, but tfx stopped waiting for validation. Ask the
        // Marketplace instead of guessing from the exit code.
        if (VALIDATION_PENDING.test(output)) {
            const m = output.match(ISVALID_HINT);
            const target = m ? { publisher: m[1], extensionId: m[2], version: m[3] } : {};
            console.log(
                'publish-marketplace: tfx stopped waiting for Marketplace validation. The upload itself ' +
                'succeeded — checking whether the version is live rather than failing the release.',
            );
            const state = await isPublishedAndValid(target);
            if (state === 'valid') {
                console.log('publish-marketplace: the version is published and valid. Treating the publish as complete.');
                return 0;
            }
            if (state === 'invalid') {
                console.error('publish-marketplace: the Marketplace reports the uploaded version as INVALID. Failing.');
                return code || 1;
            }
            // Could not determine. Fail rather than assume -- but say plainly
            // what state the release is in, because the upload DID land and a
            // retry will now hit the duplicate-version path below.
            console.error(
                'publish-marketplace: could not determine the validation state. The upload reached the ' +
                'Marketplace, so the version may still go live on its own; re-running this job will report ' +
                'the version as already published, which this script now treats as success. ' +
                'Check with: tfx extension isvalid --publisher <p> --extension-id <id> --version <v>',
            );
            return code || 1;
        }

        // Already on the Marketplace. Resolved by evidence, not by attempt
        // count: a workflow-level re-run is a fresh process whose attempt
        // counter starts at 1, which is exactly the case the old
        // `attempt > 1` gate could not serve.
        if (ALREADY_PUBLISHED.test(output)) {
            const d = output.match(DUPLICATE_DETAIL);
            const sameVersion = d && d[2] === d[3];
            const target = d
                ? { publisher: (d[1].split('.')[0]), extensionId: d[1].split('.').slice(1).join('.'), version: d[3] }
                : {};
            if (!sameVersion && attempt === 1) {
                console.error(
                    'publish-marketplace: the Marketplace already holds a DIFFERENT version than the one being ' +
                    'published, on a first attempt. That is a real rejection, not a lost response. Failing.',
                );
                return code || 1;
            }
            const state = await isPublishedAndValid(target);
            if (state === 'invalid') {
                console.error('publish-marketplace: the published version exists but is INVALID. Failing.');
                return code || 1;
            }
            console.log(
                `publish-marketplace: the version being published is already on the Marketplace (${state}). ` +
                'A previous attempt or run reached it successfully. Treating the publish as complete.',
            );
            return 0;
        }

        if (!TRANSIENT.test(output)) {
            console.error(`publish-marketplace: attempt ${attempt} failed with a non-retryable error (exit ${code}). Not retrying.`);
            return code || 1;
        }

        if (attempt === maxAttempts) {
            console.error(`publish-marketplace: attempt ${attempt} failed with a transient error and no attempts remain (exit ${code}).`);
            return code || 1;
        }

        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.error(`publish-marketplace: attempt ${attempt} failed with a transient error (exit ${code}); retrying in ${delay}ms.`);
        await sleep(delay);
    }
    /* c8 ignore next */
    return 1;
}

main().then((code) => process.exit(code), (err) => fail(err instanceof Error ? err.message : String(err)));
