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

// The version is already on the Marketplace. Only meaningful on a RETRY, where
// it means a previous attempt succeeded upstream and we lost the response.
const ALREADY_PUBLISHED = /already exists|already been published|already published|version .{0,40}\bexists\b/i;

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

async function main() {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`publish-marketplace: attempt ${attempt}/${maxAttempts}`);
        const { code, output } = await publishOnce();

        if (code === 0) {
            console.log(`publish-marketplace: published on attempt ${attempt}.`);
            return 0;
        }

        if (attempt > 1 && ALREADY_PUBLISHED.test(output)) {
            console.log(
                `publish-marketplace: attempt ${attempt} reports the version is already published — ` +
                'a previous attempt reached the Marketplace and its response was lost. Treating the publish as complete.',
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
