import * as assert from 'assert';
import { scrubSecrets, sanitizeAttachmentName } from '../../src/results/secret-scrub';

describe('scrubSecrets — freeform diagnostic scrub (§5.4)', () => {
  it('removes an explicitly-registered secret literal', () => {
    const out = scrubSecrets('login failed for token abcd-token-1234 today', ['abcd-token-1234']);
    assert.ok(!out.includes('abcd-token-1234'));
    assert.ok(out.includes('(redacted)'));
    assert.ok(out.includes('login failed'), 'surrounding text preserved');
  });

  it('removes multiple occurrences of a registered secret', () => {
    const out = scrubSecrets('X=SEKRETVALUE and again SEKRETVALUE', ['SEKRETVALUE']);
    assert.strictEqual(out.match(/SEKRETVALUE/g), null);
  });

  it('scrubs a PEM private-key block by heuristic', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----';
    const out = scrubSecrets(`error near key ${pem} end`, []);
    assert.ok(!out.includes('MIIEpAIBAAKCAQEA1234'));
    assert.ok(out.includes('(redacted PEM)'));
  });

  it('scrubs a long high-entropy base64/hex run by heuristic', () => {
    const token = 'A'.repeat(20) + 'b3F9' + 'C'.repeat(20); // > 40 chars
    const out = scrubSecrets(`bearer ${token} rejected`, []);
    assert.ok(!out.includes(token));
    assert.ok(out.includes('(redacted)'));
  });

  it('leaves a benign diagnostic intact (no over-scrubbing)', () => {
    const benign = 'Error: invalid value "us-east-1" for region; expected one of us-west-2, eu-central-1.';
    assert.strictEqual(scrubSecrets(benign, []), benign);
  });

  it('ignores empty / too-short registered secrets (avoids catastrophic over-scrub)', () => {
    const text = 'the letter a appears often in banana';
    assert.strictEqual(scrubSecrets(text, ['', 'a']), text);
  });

  it('returns non-string / empty input unchanged', () => {
    assert.strictEqual(scrubSecrets('', ['x']), '');
    assert.strictEqual(scrubSecrets(undefined as unknown as string, ['x']), undefined as unknown as string);
  });
});

describe('sanitizeAttachmentName — logging-command / CRLF injection guard (§5.6)', () => {
  it('strips CR/LF and logging-command control characters', () => {
    const r = sanitizeAttachmentName('name\r\nwith];%injection');
    assert.strictEqual(r.name, 'namewithinjection');
    assert.ok(r.note && r.note.includes('sanitized'));
  });

  it('leaves a clean name unchanged with no note', () => {
    const r = sanitizeAttachmentName('terraform-plan_prod.01');
    assert.strictEqual(r.name, 'terraform-plan_prod.01');
    assert.strictEqual(r.note, undefined);
  });

  it('caps an overly long name and notes the truncation', () => {
    const r = sanitizeAttachmentName('n'.repeat(500));
    assert.strictEqual(r.name.length, 256);
    assert.ok(r.note && r.note.includes('truncated'));
  });

  it('falls back to "terraform" when the sanitized name is empty', () => {
    const r = sanitizeAttachmentName('\r\n];%');
    assert.strictEqual(r.name, 'terraform');
  });

  it('handles a non-string input', () => {
    const r = sanitizeAttachmentName(undefined as unknown as string);
    assert.strictEqual(r.name, 'terraform');
  });
});
