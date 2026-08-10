import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import tasks = require('azure-pipelines-task-lib/task');
import { TempFileManager } from '../src/temp-file-manager';

/**
 * Direct unit tests for the temp-file lifecycle extracted in #878 PR 1.
 *
 * These exist in the same PR as the extraction, not as a follow-up, because the
 * error branches below (scrub failure, unlink failure) were the uncovered
 * cluster inside base-terraform-command-handler.js. Measured alone in a small
 * new file rather than averaged into a 2,300-line one, leaving them untested
 * would have put this module under its own 60% floor.
 */
describe('TempFileManager (#878)', function () {
  const origWarning = tasks.warning;
  const origDebug = tasks.debug;
  let warnings: string[] = [];
  let scratch: string;

  beforeEach(() => {
    warnings = [];
    (tasks as unknown as { warning: (m: string) => void }).warning = (m: string) => { warnings.push(m); };
    (tasks as unknown as { debug: (m: string) => void }).debug = () => { };
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-test-'));
  });

  afterEach(() => {
    (tasks as unknown as { warning: typeof origWarning }).warning = origWarning;
    (tasks as unknown as { debug: typeof origDebug }).debug = origDebug;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const writeFile = (name: string): string => {
    const p = path.join(scratch, name);
    fs.writeFileSync(p, 'secret-content');
    return p;
  };

  it('cleanup() scrubs and deletes tracked files', () => {
    const m = new TempFileManager();
    const a = writeFile('a.txt');
    m.track(a);
    m.cleanup();
    assert.strictEqual(fs.existsSync(a), false);
    assert.deepStrictEqual(m.tracked, []);
  });

  it('cleanup() leaves emergency-only files alone, so downstream steps can still read them', () => {
    const m = new TempFileManager();
    const ordinary = writeFile('ordinary.txt');
    const retained = writeFile('retained.json');
    m.track(ordinary);
    m.trackEmergencyOnly(retained);

    m.cleanup();

    assert.strictEqual(fs.existsSync(ordinary), false);
    assert.strictEqual(fs.existsSync(retained), true, 'the emergency-only file must survive a normal step (#650)');
  });

  it('emergencyCleanup() removes both tiers', () => {
    const m = new TempFileManager();
    const ordinary = writeFile('ordinary.txt');
    const retained = writeFile('retained.json');
    m.track(ordinary);
    m.trackEmergencyOnly(retained);

    m.emergencyCleanup();

    assert.strictEqual(fs.existsSync(ordinary), false);
    assert.strictEqual(fs.existsSync(retained), false);
    assert.deepStrictEqual(m.trackedEmergencyOnly, []);
  });

  it('is a safe no-op when nothing was tracked, and when a tracked path never existed', () => {
    const m = new TempFileManager();
    assert.doesNotThrow(() => m.emergencyCleanup());
    m.track(path.join(scratch, 'never-created.txt'));
    assert.doesNotThrow(() => m.cleanup());
    assert.strictEqual(warnings.length, 0, 'an absent path is not an error worth warning about');
  });

  it('warns but still unlinks when the scrub fails', () => {
    const m = new TempFileManager();
    const target = writeFile('scrub-fails.txt');
    // Stub the module export rather than an fs primitive: the compiled require()
    // is resolved at call time, so this reliably intercepts scrubFile itself
    // regardless of which fs calls it happens to make.
    const secureTemp = require('../src/secure-temp');
    const origScrub = secureTemp.scrubFile;
    secureTemp.scrubFile = () => { throw new Error('scrub boom'); };
    try {
      m.track(target);
      m.cleanup();
    } finally {
      secureTemp.scrubFile = origScrub;
    }

    assert.strictEqual(fs.existsSync(target), false, 'a scrub failure must not skip the unlink -- the file still has to go');
    assert.ok(warnings.some((w) => /Failed to scrub temp file/.test(w)), `expected a scrub warning; got: ${warnings.join(' | ')}`);
  });

  it('warns and continues to the next file when an unlink fails', () => {
    const m = new TempFileManager();
    const doomed = writeFile('doomed.txt');
    const survivor = writeFile('survivor.txt');
    const origUnlink = fs.unlinkSync;
    (fs as unknown as { unlinkSync: (p: string) => void }).unlinkSync = (p: string) => {
      if (p === doomed) throw new Error('unlink boom');
      origUnlink(p);
    };
    try {
      m.track(doomed);
      m.track(survivor);
      m.cleanup();
    } finally {
      (fs as unknown as { unlinkSync: typeof origUnlink }).unlinkSync = origUnlink;
    }

    assert.ok(warnings.some((w) => /Failed to clean up temp file/.test(w)), 'a leftover credential file must be surfaced above debug');
    assert.strictEqual(fs.existsSync(survivor), false, 'one failure must not abort cleanup of the remaining files');
  });

  it('hands out copies, so an observer cannot register a file by mutating the view', () => {
    const m = new TempFileManager();
    m.track('/tmp/one');
    (m.tracked as string[]).push('/tmp/injected');
    assert.deepStrictEqual(m.tracked, ['/tmp/one']);
  });
});
