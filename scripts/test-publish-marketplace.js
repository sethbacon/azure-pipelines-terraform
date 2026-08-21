#!/usr/bin/env node
// Table-driven self-test for scripts/publish-marketplace.js.
//
// BYTE-IDENTICAL across sethbacon/azure-pipelines-terraform,
// sethbacon/azure-pipelines-packer and sethbacon/azure-pipelines-release-docs,
// alongside the script it tests.
//
// A retry wrapper nobody has watched fail is not a guard, so every row below
// drives the REAL script against a fake `tfx` that records how it was invoked
// and can be scripted to fail transiently, fail permanently, or succeed. The
// rows assert the two disciplines the wrapper exists to enforce -- the token
// arrives on stdin and never on argv, and a transient upstream failure is
// retried while a deterministic one is not -- plus the attempt counts, so a
// change that silently stops retrying (or starts retrying a hard rejection)
// goes red here.
//
// Runs with PUBLISH_RETRY_BASE_MS=0 so the backoff does not slow CI down; the
// backoff arithmetic itself is not under test, the retry DECISIONS are.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'publish-marketplace.js');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-marketplace-selftest-'));
const TOKEN = 'fake-entra-access-token-value';

let failed = false;

function check(cond, okMsg, failMsg, extra) {
    if (cond) {
        console.log(`OK: ${okMsg}`);
    } else {
        console.error(`FAIL: ${failMsg}`);
        if (extra !== undefined) console.error(extra);
        failed = true;
    }
}

/**
 * Writes a fake tfx that appends one JSON line per invocation (argv + the stdin
 * it received) to `logFile`, then emits `script[n]` for its nth invocation.
 * Each entry is { out, code }.
 */
function makeFakeTfx(dir, logFile, script) {
    const file = path.join(dir, 'fake-tfx.js');
    fs.writeFileSync(
        file,
        `#!/usr/bin/env node
const fs = require('fs');
const logFile = ${JSON.stringify(logFile)};
const script = ${JSON.stringify(script)};
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const priorCalls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\\n').filter(Boolean).length : 0;
  fs.appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
  const step = script[Math.min(priorCalls, script.length - 1)];
  process.stdout.write(step.out + '\\n');
  process.exit(step.code);
});
`,
        { mode: 0o755 },
    );
    return file;
}

function run(name, script, env = {}) {
    const dir = fs.mkdtempSync(path.join(scratchDir, `${name}-`));
    const logFile = path.join(dir, 'calls.jsonl');
    const tfx = makeFakeTfx(dir, logFile, script);
    const res = spawnSync(
        process.execPath,
        [scriptPath, '--vsix', path.join(dir, 'fake.vsix'), '--tfx', tfx],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                MARKETPLACE_TOKEN: TOKEN,
                PUBLISH_RETRY_BASE_MS: '0',
                PUBLISH_MAX_ATTEMPTS: '3',
                ...env,
            },
        },
    );
    const calls = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
    return { res, calls, out: `${res.stdout}${res.stderr}` };
}

const OK = { out: 'Extension published successfully', code: 0 };
const TRANSIENT_503 = { out: 'Error: Request failed with status code 503 Service Unavailable', code: 1 };
const TRANSIENT_RESET = { out: 'Error: read ECONNRESET', code: 1 };
const PERMANENT = { out: 'Error: TF400898: manifest is invalid: missing publisher', code: 1 };
const ALREADY = { out: 'Error: The extension version 1.2.7 already exists.', code: 1 };

// The two shapes tfx ACTUALLY emitted when v1.14.4's release failed twice
// (2026-08-20), reproduced verbatim. Neither was classified correctly before:
// the first was read as a non-retryable failure although the upload had
// succeeded, and the second matched none of ALREADY_PUBLISHED's alternatives.
const VALIDATION_TIMEOUT = {
    out: [
        'error: Error: Validation is taking much longer than usual. TFX is exiting. To get the validation status, you may run the command below. This extension will be available after validation is successful.',
        'error: ',
        'error: tfx extension isvalid --publisher sethbacon --extension-id pipeline-tasks-terraform --version 1.14.4 --service-url https://marketplace.visualstudio.com/ --token <your PAT>',
    ].join('\n'),
    code: 255,
};
const ISVALID_OK = { out: 'Extension is valid', code: 0 };
const ISVALID_BAD = { out: 'Extension validation failed: invalid manifest', code: 0 };
// Same version on both sides: a previous attempt or run already landed it.
const DUP_SAME = {
    out: 'error: Version number must increase each time an extension is published.  Extension: sethbacon.pipeline-tasks-terraform  Current version: 1.14.4  Updated version: 1.14.4',
    code: 255,
};
// A LOWER version than what is live: a real mistake, not a lost response.
const DUP_OLDER = {
    out: 'error: Version number must increase each time an extension is published.  Extension: sethbacon.pipeline-tasks-terraform  Current version: 1.15.0  Updated version: 1.14.4',
    code: 255,
};

// Each row is one enumerated behaviour of the wrapper.
const CASES = [
    {
        name: 'success-first-attempt',
        script: [OK],
        expectExit: 0,
        expectCalls: 1,
        why: 'a clean publish runs tfx exactly once',
    },
    {
        name: 'transient-then-success',
        script: [TRANSIENT_503, OK],
        expectExit: 0,
        expectCalls: 2,
        why: 'a transient 503 (the v1.2.7 failure) is retried and the release completes',
    },
    {
        name: 'transient-transport-then-success',
        script: [TRANSIENT_RESET, OK],
        expectExit: 0,
        expectCalls: 2,
        why: 'a transport-level failure (ECONNRESET) is retried too, not just HTTP 5xx',
    },
    {
        name: 'transient-exhausted',
        script: [TRANSIENT_503],
        expectExit: 1,
        expectCalls: 3,
        why: 'retries are BOUNDED: PUBLISH_MAX_ATTEMPTS attempts, then the release fails',
    },
    {
        name: 'permanent-not-retried',
        script: [PERMANENT, OK],
        expectExit: 1,
        expectCalls: 1,
        why: 'a deterministic rejection (invalid manifest) fails fast and is NEVER retried',
    },
    {
        name: 'already-published-after-retry',
        script: [TRANSIENT_503, ALREADY],
        expectExit: 0,
        expectCalls: 2,
        why: 'a retry that finds the version already published means the lost first response succeeded',
    },
    {
        name: 'already-published-first-attempt',
        script: [ALREADY],
        expectExit: 1,
        expectCalls: 1,
        why: 'the same message on the FIRST attempt is a real duplicate-version error and still fails',
    },
    {
        name: 'validation-timeout-then-valid',
        script: [VALIDATION_TIMEOUT, ISVALID_OK],
        expectExit: 0,
        expectCalls: 2,
        why: 'tfx giving up on the validation WAIT is not a publish failure -- the upload landed, so the '
            + 'script asks isvalid and completes the release instead of stranding it in draft (v1.14.4)',
    },
    {
        name: 'validation-timeout-then-invalid',
        script: [VALIDATION_TIMEOUT, ISVALID_BAD],
        expectExit: 255,
        expectCalls: 2,
        why: 'if the Marketplace says the uploaded version is INVALID, that is a real failure and must not '
            + 'be papered over by the same branch that rescues a slow validation',
    },
    {
        name: 'duplicate-same-version-first-attempt',
        script: [DUP_SAME, ISVALID_OK],
        expectExit: 0,
        expectCalls: 2,
        why: 'a workflow-level RE-RUN is a fresh process at attempt 1, so the old attempt>1 gate could never '
            + 'serve it; the version being published is already live, which is evidence the work is done',
    },
    {
        name: 'duplicate-older-version-first-attempt',
        script: [DUP_OLDER],
        expectExit: 255,
        expectCalls: 1,
        why: 'publishing a version LOWER than the one live is a real rejection and still fails on attempt 1 '
            + '-- the property the original attempt>1 gate existed to protect',
    },
];

try {
    for (const c of CASES) {
        const { res, calls, out } = run(c.name, c.script);
        check(
            res.status === c.expectExit && calls.length === c.expectCalls,
            `${c.name}: exit ${res.status}, ${calls.length} tfx invocation(s) — ${c.why}`,
            `${c.name}: expected exit ${c.expectExit} and ${c.expectCalls} invocation(s), got exit ${res.status} and ${calls.length}`,
            out,
        );
        for (const call of calls) {
            check(
                !call.argv.some((a) => a.includes(TOKEN)),
                `${c.name}: the token never appears on tfx's argv (${call.argv.join(' ')})`,
                `${c.name}: the token LEAKED onto tfx's argv: ${call.argv.join(' ')}`,
            );
            check(
                call.stdin.trim() === TOKEN,
                `${c.name}: the token is delivered on tfx's stdin`,
                `${c.name}: expected the token on stdin, got '${call.stdin.trim()}'`,
            );
            check(
                !call.argv.includes('--token'),
                `${c.name}: tfx is invoked without --token, so it prompts on stdin`,
                `${c.name}: tfx was invoked with --token`,
            );
        }
    }

    // A missing token must fail before tfx is ever spawned.
    {
        const dir = fs.mkdtempSync(path.join(scratchDir, 'no-token-'));
        const logFile = path.join(dir, 'calls.jsonl');
        const tfx = makeFakeTfx(dir, logFile, [OK]);
        const env = { ...process.env, PUBLISH_RETRY_BASE_MS: '0' };
        delete env.MARKETPLACE_TOKEN;
        const res = spawnSync(process.execPath, [scriptPath, '--vsix', 'fake.vsix', '--tfx', tfx], { encoding: 'utf8', env });
        check(
            res.status !== 0 && !fs.existsSync(logFile),
            'missing MARKETPLACE_TOKEN: fails before tfx is spawned',
            `missing MARKETPLACE_TOKEN: expected a non-zero exit and no tfx invocation, got exit ${res.status}`,
            `${res.stdout}${res.stderr}`,
        );
    }
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\npublish-marketplace.js self-test: FAILED.');
    process.exit(1);
}
console.log('\npublish-marketplace.js self-test: all cases passed.');
