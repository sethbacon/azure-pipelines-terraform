import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
import crypto = require('crypto');
import tasks = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');
import { isVerificationFailure } from '@4cloudguru/pipeline-task-core';
import { verifyCosignSignature } from '../src/cosign-verifier';
import { getPlatformString } from '../src/tool-integrity';
import * as httpClient from '../src/http-client';
import * as cosignPins from '../src/cosign-pins';

/**
 * CLASS TEST — a verification control that is satisfiable without verifying
 * (#1027 / #1118), defect class `verification-satisfiable-without-verifying`,
 * signature `path-resolved-verifier-never-hashed`.
 *
 * The class, stated as a property rather than as one call site: whenever this
 * extension REQUIRES an external tool to establish authenticity, the binary that
 * performs the check must itself be one this task installed and hashed. A verifier
 * discovered on the agent's ambient PATH proves nothing about itself, so
 * `requireCosignVerification: true` on the shipped default could be satisfied by
 * any executable named `cosign` that exits 0 — the verification step ran, reported
 * success, and established nothing.
 *
 * WHY THIS IS NOT A MOCK-RUNNER SUITE. #1118 is explicit that "an assertion on
 * `tr.failed` alone will not distinguish it", and MockTestRunner makes the
 * load-bearing assertion literally inexpressible: it intercepts `tl.which` and
 * `tl.exec`, so no real process is ever spawned and a real `cosign` stub planted on
 * PATH is unreachable by construction — "the PATH stub was never executed" would
 * pass vacuously in a child runner even on a task that resolves from PATH. These
 * tests therefore run in the mocha parent process with the REAL task-lib, plant a
 * REAL executable named `cosign` on a REAL prepended PATH entry (so
 * `tasks.which('cosign')` genuinely resolves to it), and assert on the ONE seam
 * through which this module can execute anything: the path handed to
 * `tasks.tool()`. Nothing else in verifyCosignSignature can start a process.
 *
 * Each row therefore asserts WHICH BINARY WOULD HAVE RUN, not merely whether the
 * call threw. The mutation that matters — making the managed branch fall through to
 * the PATH lookup — turns row 1 red on both counts (the executed path becomes the
 * PATH stub instead of a tool-cache path, and `tasks.which` gets consulted at all)
 * while leaving every ambient row green, which is exactly the discrimination #1118
 * says a `tr.failed` assertion cannot make.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Bytes the stubbed downloader "fetches" as the managed cosign release asset, and
// their real digest. verifySha256 runs for real against these, so a row that
// declares a mismatching pin fails through the production code path, not a stub.
const MANAGED_ASSET_BYTES = Buffer.from('#!/bin/sh\n# stand-in for the pinned cosign release asset\nexit 0\n');
const MANAGED_ASSET_SHA256 = crypto.createHash('sha256').update(MANAGED_ASSET_BYTES).digest('hex');
const WRONG_SHA256 = 'a'.repeat(64);

const VERSION = '1.11.6';
const PLATFORM = getPlatformString();
const IS_WINDOWS = PLATFORM === 'windows';
// The real asset name for this agent, from the real table — only the DIGEST is
// substituted below (no offline test can produce a preimage of a real cosign
// release). The table's own contents are asserted in CosignPinsL0.
const REAL_ASSET_NAME = cosignPins.cosignAssetName(PLATFORM, os.arch()) ?? 'cosign-linux-amd64';

type Row = {
    what: string;
    /** undefined = omit the argument entirely, i.e. the SHIPPED DEFAULT. */
    source?: 'managed' | 'ambient';
    required: boolean;
    /** Digest the (stubbed) pin table advertises for the managed asset. */
    pin?: 'match' | 'mismatch' | 'unsupported-platform';
    downloadFails?: boolean;
    /** The operator-supplied cosignSha256 input. */
    operatorPin?: 'matches-managed' | 'matches-path-stub' | 'wrong';
    /** Expected outcome: 'resolves', or the message the rejection must match. */
    expect: 'resolves' | RegExp;
    /** Which binary the verifier handed to a ToolRunner. */
    ran: 'managed' | 'path-stub' | 'nothing';
    /** How many times the ambient PATH lookup was consulted. */
    whichCalls: number;
    /** Whether the "trusted without an integrity check of its own" warning fires. */
    unpinnedWarning: boolean;
};

const ROWS: Row[] = [
    {
        what: 'the SHIPPED DEFAULT (cosignSource omitted) runs the managed, pin-verified cosign and never consults PATH',
        required: true,
        pin: 'match',
        expect: 'resolves',
        ran: 'managed',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'an explicit cosignSource=managed behaves identically to the default',
        source: 'managed',
        required: true,
        pin: 'match',
        expect: 'resolves',
        ran: 'managed',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'a managed download whose digest does not match the pin fails closed and runs nothing',
        source: 'managed',
        required: true,
        pin: 'mismatch',
        // Matches the localized text and, in this direct (non-mock-runner) context
        // where task.json resources are not loaded, its loc KEY.
        expect: /sha256 ?verification ?failed/i,
        ran: 'nothing',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'a managed download FAILURE with verification required fails closed — it never falls back to the PATH binary',
        source: 'managed',
        required: true,
        pin: 'match',
        downloadFails: true,
        expect: /Refusing to fall back to an unverified cosign/,
        ran: 'nothing',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'a platform the pinned release publishes no asset for fails closed, naming the ambient opt-out',
        source: 'managed',
        required: true,
        pin: 'unsupported-platform',
        expect: /publishes no binary for [\s\S]*cosignSource to 'ambient'/,
        ran: 'nothing',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'a managed download failure with verification NOT required degrades with a warning, still without touching PATH',
        source: 'managed',
        required: false,
        pin: 'match',
        downloadFails: true,
        expect: 'resolves',
        ran: 'nothing',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'an operator cosignSha256 is still honoured on the managed path when it matches',
        source: 'managed',
        required: true,
        pin: 'match',
        operatorPin: 'matches-managed',
        expect: 'resolves',
        ran: 'managed',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'an operator cosignSha256 that does NOT match the managed binary fails closed',
        source: 'managed',
        required: true,
        pin: 'match',
        operatorPin: 'wrong',
        expect: /does not match the pinned cosignSha256/,
        ran: 'nothing',
        whichCalls: 0,
        unpinnedWarning: false,
    },
    {
        what: 'cosignSource=ambient keeps the historical PATH lookup and runs the binary PATH resolves',
        source: 'ambient',
        required: true,
        expect: 'resolves',
        ran: 'path-stub',
        whichCalls: 1,
        unpinnedWarning: true,
    },
    {
        what: 'cosignSource=ambient with an operator pin that matches the PATH binary runs it without the unpinned warning',
        source: 'ambient',
        required: true,
        operatorPin: 'matches-path-stub',
        expect: 'resolves',
        ran: 'path-stub',
        whichCalls: 1,
        unpinnedWarning: false,
    },
    {
        what: 'cosignSource=ambient with an operator pin the PATH binary does not satisfy fails closed',
        source: 'ambient',
        required: true,
        operatorPin: 'wrong',
        expect: /does not match the pinned cosignSha256/,
        ran: 'nothing',
        whichCalls: 1,
        unpinnedWarning: false,
    },
];

describe('managed verifier resolution (class test #1027/#1118)', function () {
    this.timeout(20000);

    const t = tasks as any;
    const tools = toolLib as any;
    const hc = httpClient as any;
    const pins = cosignPins as any;

    const original = {
        which: t.which, warning: t.warning, debug: t.debug, tool: t.tool, getVariable: t.getVariable,
        findLocalTool: tools.findLocalTool, downloadTool: tools.downloadTool, cacheFile: tools.cacheFile,
        fetchBufferAllow404: hc.fetchBufferAllow404,
        resolveCosignPin: pins.resolveCosignPin,
        PATH: process.env.PATH,
    };

    let sandbox = '';
    let pathStubDir = '';
    let pathStubPath = '';
    let toolCacheRoot = '';
    let agentTemp = '';
    let downloadRoot = '';

    // Observations each row asserts on.
    let ranPaths: string[] = [];
    let whichCalls = 0;
    let downloadCalls = 0;
    let warnings: string[] = [];
    let logs: string[] = [];

    before(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cosign-'));
        pathStubDir = path.join(sandbox, 'pathbin');
        agentTemp = path.join(sandbox, 'agent-temp');
        fs.mkdirSync(pathStubDir);
        fs.mkdirSync(agentTemp);

        // A REAL executable named `cosign`, first on PATH. `tasks.which('cosign')`
        // resolves to this for real — the ambient rows below prove it does, which is
        // what makes "the managed rows never reached it" a meaningful statement
        // rather than an artefact of a stubbed lookup.
        pathStubPath = path.join(pathStubDir, IS_WINDOWS ? 'cosign.cmd' : 'cosign');
        fs.writeFileSync(pathStubPath, IS_WINDOWS ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
        if (!IS_WINDOWS) { fs.chmodSync(pathStubPath, 0o755); }
        process.env.PATH = `${pathStubDir}${path.delimiter}${original.PATH ?? ''}`;
    });

    after(() => {
        process.env.PATH = original.PATH;
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    beforeEach(() => {
        ranPaths = [];
        whichCalls = 0;
        downloadCalls = 0;
        warnings = [];
        logs = [];
        toolCacheRoot = fs.mkdtempSync(path.join(sandbox, 'toolcache-'));
        downloadRoot = fs.mkdtempSync(path.join(sandbox, 'downloads-'));

        t.warning = (m: string) => { warnings.push(m); };
        t.debug = (_m: string) => { /* silence */ };
        t.getVariable = (name: string) => (name === 'Agent.TempDirectory' ? agentTemp : undefined);
        // Counts the ambient lookup while delegating to the REAL which, so the
        // ambient rows exercise real PATH resolution against the real stub file.
        t.which = (tool: string, check?: boolean) => { whichCalls++; return original.which.call(tasks, tool, check); };
        // The single execution seam of this module. Recording instead of spawning is
        // what makes "the PATH stub was never executed" observable per row.
        t.tool = (toolPath: string) => {
            ranPaths.push(toolPath);
            return { arg() { return this; }, exec: async () => 0 };
        };
        hc.fetchBufferAllow404 = async () => new Uint8Array([1, 2, 3]);

        // A minimal, real-on-disk stand-in for the agent tool cache.
        tools.findLocalTool = (tool: string, version: string) => {
            const dir = path.join(toolCacheRoot, tool, version);
            return fs.existsSync(dir) ? dir : null;
        };
        tools.cacheFile = async (sourceFile: string, targetFile: string, tool: string, version: string) => {
            const dir = path.join(toolCacheRoot, tool, version);
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(sourceFile, path.join(dir, targetFile));
            return dir;
        };
    });

    afterEach(() => {
        Object.assign(t, {
            which: original.which, warning: original.warning, debug: original.debug,
            tool: original.tool, getVariable: original.getVariable,
        });
        tools.findLocalTool = original.findLocalTool;
        tools.downloadTool = original.downloadTool;
        tools.cacheFile = original.cacheFile;
        hc.fetchBufferAllow404 = original.fetchBufferAllow404;
        pins.resolveCosignPin = original.resolveCosignPin;
    });

    function armPin(row: Row): void {
        if (row.pin === 'unsupported-platform') {
            pins.resolveCosignPin = () => undefined;
            return;
        }
        const sha256 = row.pin === 'mismatch' ? WRONG_SHA256 : MANAGED_ASSET_SHA256;
        pins.resolveCosignPin = () => ({ assetName: REAL_ASSET_NAME, sha256 });
    }

    function armDownload(row: Row): void {
        tools.downloadTool = async (_url: string, fileName: string) => {
            downloadCalls++;
            if (row.downloadFails) { throw new Error('simulated network failure'); }
            const target = path.join(downloadRoot, fileName);
            fs.writeFileSync(target, MANAGED_ASSET_BYTES);
            return target;
        };
    }

    function operatorPinValue(row: Row): string | undefined {
        switch (row.operatorPin) {
            case 'matches-managed': return MANAGED_ASSET_SHA256;
            case 'matches-path-stub': return crypto.createHash('sha256').update(fs.readFileSync(pathStubPath)).digest('hex');
            case 'wrong': return WRONG_SHA256;
            default: return undefined;
        }
    }

    async function invoke(row: Row): Promise<void> {
        const args: unknown[] = [
            'sums-content', 'https://x.example/sig', 'https://x.example/pem', VERSION,
            row.required, operatorPinValue(row),
        ];
        // A row with no `source` omits the argument entirely: that IS the shipped
        // default, and a mutation that changes the parameter's default value must
        // turn these rows red rather than being papered over by an explicit argument.
        if (row.source !== undefined) { args.push(row.source); }
        await (verifyCosignSignature as any)(...args);
    }

    for (const row of ROWS) {
        it(row.what, async () => {
            armPin(row);
            armDownload(row);
            const origLog = console.log;
            console.log = (m?: unknown) => { logs.push(String(m)); };
            try {
                if (row.expect === 'resolves') {
                    await invoke(row);
                } else {
                    const pattern = row.expect;
                    await assert.rejects(invoke(row), (err: unknown) => {
                        assert.ok(
                            isVerificationFailure(err),
                            `a refusal to trust a verifier must be a typed VerificationFailure so the cache-hit re-verification path fails closed; got ${err}`,
                        );
                        assert.match((err as Error).message, pattern);
                        return true;
                    });
                }
            } finally {
                console.log = origLog;
            }

            // --- the load-bearing assertions -------------------------------------
            if (row.ran === 'nothing') {
                assert.deepStrictEqual(ranPaths, [], `nothing may be executed on this path; got ${ranPaths.join(', ')}`);
            } else {
                assert.strictEqual(ranPaths.length, 1, `expected exactly one cosign invocation; got ${ranPaths.join(', ')}`);
            }
            if (row.ran === 'managed') {
                assert.notStrictEqual(ranPaths[0], pathStubPath, 'the managed path must NOT execute the cosign planted on PATH');
                assert.ok(
                    ranPaths[0].startsWith(toolCacheRoot),
                    `the executed cosign must come from the tool cache the task populated; got ${ranPaths[0]}`,
                );
                assert.strictEqual(path.basename(ranPaths[0]), REAL_ASSET_NAME, 'the executed cosign must be the pinned release asset');
            }
            if (row.ran === 'path-stub') {
                assert.strictEqual(ranPaths[0], pathStubPath, 'the ambient opt-out must execute the binary PATH resolves');
            }
            assert.strictEqual(
                whichCalls, row.whichCalls,
                `ambient PATH lookups: expected ${row.whichCalls}, got ${whichCalls} — a managed run that consults PATH at all has re-opened #1027`,
            );
            const warned = warnings.some((w) => /trusted without an integrity check of its own/.test(w));
            assert.strictEqual(
                warned, row.unpinnedWarning,
                `unpinned-cosign warning expected=${row.unpinnedWarning}; warnings: ${warnings.join(' | ')}`,
            );
            if (row.ran !== 'nothing') {
                assert.ok(
                    logs.some((l) => l.includes(ranPaths[0]) && /SHA256 [0-9a-f]{64}/.test(l)),
                    `the binary that was trusted must stay auditable: path + real digest on one log line. logs: ${logs.join('\n')}`,
                );
            }
        });
    }

    it('reuses a cached, pin-matching managed cosign without downloading it again', async () => {
        const row: Row = { what: '', source: 'managed', required: true, pin: 'match', expect: 'resolves', ran: 'managed', whichCalls: 0, unpinnedWarning: false };
        armPin(row);
        armDownload(row);
        const origLog = console.log;
        console.log = (m?: unknown) => { logs.push(String(m)); };
        try {
            await invoke(row);
            await invoke(row);
        } finally {
            console.log = origLog;
        }
        assert.strictEqual(downloadCalls, 1, 'the second run must be served from the tool cache, not re-downloaded');
        assert.strictEqual(ranPaths.length, 2);
        assert.strictEqual(ranPaths[0], ranPaths[1], 'both runs must execute the same cached managed binary');
        assert.strictEqual(whichCalls, 0, 'a cache hit must not consult PATH either');
    });

    it('fails CLOSED, as a typed VerificationFailure, when the cached managed cosign changed under its marker', async () => {
        const row: Row = { what: '', source: 'managed', required: true, pin: 'match', expect: 'resolves', ran: 'managed', whichCalls: 0, unpinnedWarning: false };
        armPin(row);
        armDownload(row);
        const origLog = console.log;
        console.log = (m?: unknown) => { logs.push(String(m)); };
        try {
            await invoke(row);
            // The verifier itself was altered on this agent after it was cached and
            // marked. A BARE Error here would be swallowed by the caller's
            // transient-failure branch and the never-verified cached tofu binary
            // would be installed anyway (#589/19), so the type is load-bearing.
            fs.writeFileSync(ranPaths[0], Buffer.from('an entirely different binary\n'));
            await assert.rejects(invoke(row), (err: unknown) => {
                assert.ok(isVerificationFailure(err), 'tampering with the cached verifier must never degrade to a warning');
                assert.match((err as Error).message, /failed its own integrity re-verification/);
                return true;
            });
            assert.strictEqual(ranPaths.length, 1, 'the altered cached binary must not be executed');
            assert.strictEqual(whichCalls, 0, 'and PATH must still never be consulted');
        } finally {
            console.log = origLog;
        }
    });

    it('re-downloads, rather than admitting, an UNMARKED cache entry that does not match the pin', async () => {
        const row: Row = { what: '', source: 'managed', required: true, pin: 'match', expect: 'resolves', ran: 'managed', whichCalls: 0, unpinnedWarning: false };
        armPin(row);
        armDownload(row);
        const origLog = console.log;
        console.log = (m?: unknown) => { logs.push(String(m)); };
        try {
            await invoke(row);
            const cachedExe = ranPaths[0];
            // An entry seeded by something that wrote no marker (an older installer,
            // or a different tool under the same cache key): unverifiable, not
            // tampered — it must be replaced by a fresh, pin-verified download.
            fs.writeFileSync(cachedExe, Buffer.from('an entirely different binary\n'));
            fs.rmSync(path.join(path.dirname(cachedExe), '.installer-verified.sha256'), { force: true });
            await invoke(row);
        } finally {
            console.log = origLog;
        }
        assert.strictEqual(downloadCalls, 2, 'an unmarked, non-matching cache entry must be re-downloaded');
        assert.strictEqual(
            fs.readFileSync(ranPaths[1]).toString(), MANAGED_ASSET_BYTES.toString(),
            'the executed cosign must be the freshly downloaded, pin-verified asset',
        );
        assert.strictEqual(whichCalls, 0, 'and PATH must still never be consulted');
    });
});

/* eslint-enable @typescript-eslint/no-explicit-any */
