import fs = require('fs');
import tasks = require('azure-pipelines-task-lib/task');
import { SecureFileLoader } from './secure-file-loader';
import { scrubFile } from '@4cloudguru/pipeline-task-ado';

/**
 * Owns the temp-file lifecycle for a command handler: what is tracked, what is
 * scrubbed when, and the secure var file's identity.
 *
 * Extracted from BaseTerraformCommandHandler unchanged (#878 PR 1). It holds the
 * only mutable state that class had, which is what makes the later extractions
 * mechanical rather than questions about shared state.
 *
 * Two tiers, and the distinction is the point:
 *   - {@link track}: scrubbed+deleted on normal completion AND on cancellation.
 *   - {@link trackEmergencyOnly}: scrubbed+deleted ONLY on cancellation, because a
 *     retained `terraform output -json` file has a legitimate downstream reader
 *     during the job but none once the job is cancelled (#650).
 */
export class TempFileManager {
  private tempFiles: string[] = [];
  private emergencyOnlyTempFiles: string[] = [];
  private secureFileId: string | null = null;
  // Path of the downloaded secure var file, retained so it can be scrubbed
  // (zero-overwrite) before the securefiles-common helper unlinks it (#662).
  private secureFilePath: string | null = null;

  /** Tracks a path for scrub+delete on normal completion and on cancellation. */
  public track(filePath: string): void {
    this.tempFiles.push(filePath);
  }

  /**
   * Tracks a path scrubbed+deleted ONLY on cancellation. Since #650's
   * auto-cleanup fix this holds the `terraform output -json` file only when it
   * has NO sensitive values, or the operator opted out via
   * cleanupOutputFileIfSensitive=false; a sensitive-containing file goes to
   * {@link track} instead.
   */
  public trackEmergencyOnly(filePath: string): void {
    this.emergencyOnlyTempFiles.push(filePath);
  }

  public setSecureFile(secureFileId: string, secureFilePath: string): void {
    this.secureFileId = secureFileId;
    this.secureFilePath = secureFilePath;
  }

  // Read-only views. Copies, so an observer cannot register a file by mutating
  // what it was handed -- tracking goes through track()/trackEmergencyOnly().
  public get tracked(): readonly string[] {
    return [...this.tempFiles];
  }

  public get trackedEmergencyOnly(): readonly string[] {
    return [...this.emergencyOnlyTempFiles];
  }

  /**
   * Scrubs (zero-overwrites) then unlinks each tracked temp path. Shared by
   * {@link cleanup} (normal end-of-step) and {@link emergencyCleanup}
   * (SIGTERM/cancellation). Best-effort per file: a scrub or unlink failure is
   * surfaced above debug but never aborts cleanup of the remaining files.
   */
  private scrubAndUnlink(files: string[]): void {
    for (const filePath of files) {
      try {
        if (fs.existsSync(filePath)) {
          // Scrub the content (overwrite with zeros) before unlinking, uniformly
          // for every tracked secret temp file -- OIDC/UPST/token files, GCP/OCI
          // credential JSON, PEM keys, the OCI PAR backend config-<uuid>.tf, and
          // cleartext `terraform output -json` dumps alike -- so a crash between
          // the overwrite and the unlink is the only remaining exposure window
          // (#595). A scrub failure is surfaced but does not skip the unlink
          // attempt below.
          try {
            scrubFile(filePath);
          } catch (scrubErr) {
            tasks.warning(`Failed to scrub temp file ${filePath} before deletion: ${scrubErr}`);
          }
          fs.unlinkSync(filePath);
          tasks.debug(`Cleaned up temp file: ${filePath}`);
        }
      } catch (err) {
        // A leftover credential temp file (OIDC token / GCP or OCI key)
        // is a real exposure on a self-hosted agent -- surface it
        // above debug.
        tasks.warning(`Failed to clean up temp file ${filePath}: ${err}`);
      }
    }
  }

  /**
   * Scrubs+deletes the secure var file (via securefiles-common) if one was
   * downloaded. The downloaded path is scrubbed (zero-overwrite) before the
   * vendored helper unlinks it (#662), matching the scrub-then-unlink every
   * other credential temp file gets -- the secure var file (.tfvars/.pkrvars)
   * commonly carries the very secrets passed as `-var-file`.
   */
  private cleanupSecureFile(): void {
    if (!this.secureFileId) return;
    try {
      new SecureFileLoader().deleteSecureFile(this.secureFileId, this.secureFilePath ?? undefined);
    } catch (err) {
      tasks.warning(`Failed to clean up secure file: ${err}`);
    }
    this.secureFileId = null;
    this.secureFilePath = null;
  }

  /**
   * End-of-step cleanup (normal completion). Scrubs+deletes every tracked temp
   * file and the secure var file. Deliberately does NOT touch the
   * emergency-only set -- those must survive a normal step so downstream steps
   * can still read them via the documented output-variable contract; they are
   * cleaned only on cancellation (#650).
   */
  public cleanup(): void {
    this.scrubAndUnlink(this.tempFiles);
    this.tempFiles = [];
    this.cleanupSecureFile();
  }

  /**
   * Cancellation cleanup (SIGTERM/SIGINT/uncaughtException, via
   * ParentCommandHandler.emergencyCleanup). Cleans everything {@link cleanup}
   * does, PLUS the emergency-only set: on a cancellation there is no legitimate
   * downstream reader left for a retained (non-sensitive, or explicitly
   * opted-out) output file, so its values are scrubbed+deleted then rather than
   * left on a reused self-hosted agent's temp dir until job end (#650).
   *
   * Synchronous by contract: it runs from a process-level signal handler, where
   * a returned promise would not be awaited before the process exits.
   */
  public emergencyCleanup(): void {
    this.scrubAndUnlink(this.tempFiles);
    this.tempFiles = [];
    this.scrubAndUnlink(this.emergencyOnlyTempFiles);
    this.emergencyOnlyTempFiles = [];
    this.cleanupSecureFile();
  }
}
