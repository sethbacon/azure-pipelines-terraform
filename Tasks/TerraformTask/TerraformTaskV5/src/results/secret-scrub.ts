// PRODUCER-SIDE TEXT SAFETY — the freeform-text controls that cannot ride on a
// structured mask. Two exports:
//   * scrubSecrets()          — best-effort redaction of diagnostic summary/detail
//                               (§5.4 / spec §4.9): explicit known-secret removal
//                               plus a conservative high-entropy/PEM heuristic.
//   * sanitizeAttachmentName() — strip logging-command / CRLF injection vectors
//                               from a publish name before it becomes an
//                               attachment name and is echoed into the digest
//                               (§5.6 / spec §4.10).
//
// scrubSecrets is documented BEST-EFFORT, not a guarantee: a provider can echo a
// secret the task never registered and that matches no heuristic. That residual
// risk is why `includeDiagnosticDetail` defaults to false and is recorded in
// SECURITY.md (§5.10 residual-risk register).

const REDACTED = '(redacted)';

// Known secrets shorter than this are ignored: real registered secrets (WIF
// tokens, provider creds, keys) comfortably exceed it, and replacing a 1-3 char
// string would destroy unrelated text (catastrophic over-scrub).
const MIN_KNOWN_SECRET_LEN = 4;

// PEM key/certificate blocks — multi-line, matched non-greedily.
const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

// Long high-entropy runs: base64 / base64url / hex tokens of 40+ chars. 40 is
// conservative — ordinary words and short identifiers never reach it, so benign
// diagnostics survive intact (a targeted test asserts no over-scrub).
const HIGH_ENTROPY_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/**
 * Redact secrets from a freeform diagnostic string. Explicitly-registered
 * secrets are removed first (exact literal match), then PEM blocks and long
 * high-entropy runs are scrubbed by heuristic. Returns the input unchanged when
 * nothing matches (no over-scrubbing of benign text).
 *
 * @param text         the freeform string (diagnostic summary or detail)
 * @param knownSecrets values the task registered via setSecret (order irrelevant)
 */
export function scrubSecrets(text: string, knownSecrets: string[]): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;

  // (1) explicit known-secret removal — literal replacement, longest first so a
  // secret that contains another is fully removed before its substring.
  const secrets = [...new Set(knownSecrets)]
    .filter((s) => typeof s === 'string' && s.length >= MIN_KNOWN_SECRET_LEN)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }

  // (2) heuristic scrub — PEM blocks first (they contain base64 the run rule
  // would otherwise fragment), then long high-entropy runs.
  out = out.replace(PEM_BLOCK, '(redacted PEM)');
  out = out.replace(HIGH_ENTROPY_RUN, REDACTED);

  return out;
}

// Characters that would break the `##vso[task.addattachment …;name=NAME;]path`
// logging command or inject a new command: CR/LF, the `]` terminator, the `;`
// field separator, and `%` (the ADO logging-command escape lead-in). Plus any
// other C0 control character.
const NAME_INJECTION_CHARS = /[\r\n\]%;\x00-\x1f]/g;
const MAX_ATTACHMENT_NAME_LEN = 256;

/**
 * Make a publish name safe to use as an attachment name AND to interpolate into
 * an ADO logging command. Strips CR/LF and the `]` / `;` / `%` control sequences
 * (plus other control chars) and caps the length. Returns the sanitized name and
 * an optional note when the input was altered (so the change is observable in the
 * digest's truncationNotes). An empty/blank result falls back to "terraform".
 */
export function sanitizeAttachmentName(name: string): { name: string; note?: string } {
  const raw = typeof name === 'string' ? name : '';
  let sanitized = raw.replace(NAME_INJECTION_CHARS, '');
  let capped = false;
  if (sanitized.length > MAX_ATTACHMENT_NAME_LEN) {
    sanitized = sanitized.slice(0, MAX_ATTACHMENT_NAME_LEN);
    capped = true;
  }
  const trimmed = sanitized.trim();
  const finalName = trimmed.length > 0 ? sanitized : 'terraform';
  if (sanitized !== raw || capped) {
    return { name: finalName, note: `publish name sanitized (removed control/injection characters${capped ? ', truncated' : ''})` };
  }
  return { name: finalName };
}
