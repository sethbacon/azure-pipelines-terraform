import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CLASS TEST -- credential inputs must be declared `type: password` (#867).
 *
 * Defect class: "an input whose own label/help text describes it as a
 * credential is declared `type: string`, so the classic designer renders it as
 * an ordinary textbox and persists the value in the pipeline definition in
 * cleartext, readable by anyone with pipeline-read."
 *
 * #867 reported ONE instance (backendOCIPar). Sweeping every task.json for
 * credential-shaped inputs found eight. Rather than pin the eight by name, this
 * test RE-DERIVES the set from the manifests on every run: any input whose
 * name/label/help matches the credential vocabulary must be `password`, so a
 * newly added token input fails here instead of shipping mis-declared.
 *
 * EXEMPT records the inputs that match the vocabulary but are NOT bearer
 * credentials, each with the reason -- an exemption must be a decision, not an
 * omission.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TASKS_DIR = path.join(REPO_ROOT, 'Tasks');

const CREDENTIAL_WORDS = /password|token|secret|credential|api ?key|bearer|passphrase|private key/i;

/** Inputs that read as credentials but are not, with the reason they stay non-secret. */
const EXEMPT: Record<string, string> = {
  'TerraformModulePublishV1:vcsOauthTokenId':
    'An identifier (ot-xxxxxxxx) naming an OAuth connection stored in HCP, not the token itself -- it confers no access without the separately-declared hcpToken.',
  'TerraformDriftReportV1:callbackUrl':
    'The callback endpoint. The bearer material sent to it is callbackToken, which IS declared password.',
  'TerraformTaskV5:secureVarsFile':
    'A secureFile input: the file is delivered by the agent secure-files store, which is already a secret channel.',
  'TerraformTaskV5:terraformVariables':
    'A multiLine list of NAME=VALUE pairs whose help directs sensitive values to secureVarsFile; password type cannot render multi-line.',
  'TerraformTaskV5:ociWifClientId':
    'A client identifier, not a client secret -- the OCI WIF exchange authenticates with a federated token, never a static client credential.',
  'TerraformTaskV5:publishApplyResults':
    'The NAME given to the published apply summary (e.g. "production"). It matches only because its help text explains how secrets are redacted in that summary.',
  'PublishKbArticleV1:serviceConnection':
    'A connectedService input; the credential lives in the service connection, not in the pipeline definition.',
};

type Row = { task: string; input: string; type: string };

function collectCredentialInputs(): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name === 'task.json') {
        const manifest = JSON.parse(fs.readFileSync(p, 'utf8')) as {
          inputs?: { name?: string; type?: string; label?: string; helpMarkDown?: string }[];
        };
        const taskDir = path.basename(path.dirname(p));
        for (const input of manifest.inputs ?? []) {
          const blob = `${input.name ?? ''} ${input.label ?? ''} ${input.helpMarkDown ?? ''}`;
          // Booleans/pickLists can't hold a credential regardless of wording.
          if (input.type === 'boolean' || input.type === 'pickList' || input.type === 'radio') continue;
          if (!CREDENTIAL_WORDS.test(blob)) continue;
          rows.push({ task: taskDir, input: input.name ?? '(unnamed)', type: input.type ?? '(none)' });
        }
      }
    }
  };
  walk(TASKS_DIR);
  return rows;
}

describe('credential inputs are declared as secrets (class test #867)', function () {
  const rows = collectCredentialInputs();

  it('finds credential-shaped inputs to check (guards against the sweep silently matching nothing)', () => {
    assert.ok(rows.length >= 8, `expected the manifest sweep to find credential inputs; found ${rows.length}`);
  });

  it('every credential-shaped input is either type=password or explicitly exempt', () => {
    const offenders = rows
      .filter((r) => r.type !== 'password' && !(`${r.task}:${r.input}` in EXEMPT))
      .map((r) => `${r.task}:${r.input} (type=${r.type})`);
    assert.deepStrictEqual(
      offenders,
      [],
      `these inputs read as credentials but are not declared "type": "password". Declare them password, or add an entry to EXEMPT stating why the value is not a bearer credential:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('every EXEMPT entry still corresponds to a real input (no stale exemptions)', () => {
    const present = new Set(rows.map((r) => `${r.task}:${r.input}`));
    const stale = Object.keys(EXEMPT).filter((k) => !present.has(k));
    assert.deepStrictEqual(stale, [], `EXEMPT names inputs that no longer exist: ${stale.join(', ')}`);
  });

  it('no EXEMPT entry is silently covering a password-typed input', () => {
    const byKey = new Map(rows.map((r) => [`${r.task}:${r.input}`, r.type]));
    const redundant = Object.keys(EXEMPT).filter((k) => byKey.get(k) === 'password');
    assert.deepStrictEqual(redundant, [], `these are already password and need no exemption: ${redundant.join(', ')}`);
  });
});
