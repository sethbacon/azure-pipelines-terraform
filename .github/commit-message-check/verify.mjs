// Fails a pull request whose merge commit release-please would not be able to
// read. A message its parser rejects is dropped in silence: no changelog entry,
// no version bump, no BREAKING CHANGE footer, and no later run recovers it.
import fs from 'node:fs';
import { parser } from '@conventional-commits/parser';

const commits = fs.readFileSync(process.argv[2] ?? 'commits.ndjson', 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));

// Mirrors this repository's squash settings, COMMIT_OR_PR_TITLE and
// COMMIT_MESSAGES: a lone commit keeps its own subject and body, otherwise
// GitHub takes the PR title and lists the commit messages. Merge commits are
// left out of the body.
const authored = commits.filter(commit => commit.parents <= 1);
const source = authored.length ? authored : commits;
const lone = commits.length === 1;
const [subject, ...rest] = source[0].message.split('\n');
const header = `${lone ? subject : process.env.PR_TITLE} (#${process.env.PR_NUMBER})`;
const body = lone
  ? rest.join('\n').trim()
  : source.map(commit => `* ${commit.message}`).join('\n\n');
const message = body ? `${header}\n\n${body}` : header;

const rejects = text => {
  try {
    parser(text);
    return null;
  } catch (err) {
    return err;
  }
};

const err = rejects(message);
if (!err) {
  console.log(`OK: release-please can read the squash of this PR's ${commits.length} commit(s).`);
  process.exit(0);
}

// Re-parse growing prefixes so the report can name the line that breaks it.
const lines = message.split('\n');
let culprit = null;
for (let i = 1; i < lines.length && culprit === null; i++) {
  if (rejects(lines.slice(0, i + 1).join('\n'))) culprit = lines[i];
}

const detail = String(err.message).split('\n')[0];
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
  '### This PR would merge as a commit release-please cannot read',
  '',
  'release-please parses commits with `@conventional-commits/parser`, a strict',
  'reading of the Conventional Commits grammar. It rejects the message this PR',
  'would squash into `main`:',
  '',
  '```', detail, '```',
  ...(culprit ? ['', 'The first line it cannot get past:', '', '```', culprit, '```'] : []),
  '',
  'A commit it cannot parse contributes nothing: no changelog entry, no version',
  'bump, and no `BREAKING CHANGE:` footer. release-please logs `commit could not',
  'be parsed`, reports success, and moves on -- and every later run re-reads the',
  'same commit and skips it again, so the change never reaches a changelog.',
  '',
  'The usual cause is a body line that **starts** with `name(`. The grammar reads',
  'that as a structured token, so its brackets have to be flat and closed: a line',
  'opening with `WithArgs(pq.Array(...))` voids the commit, while the same text one',
  'word further along the line is ordinary prose and parses. Reflow the line so it',
  'does not begin with the call, or drop the inner brackets.',
  '',
  'Fix the commit message on the branch, not the PR description -- this repository',
  'squashes with `COMMIT_MESSAGES`, so the body comes from the commits themselves.',
].join('\n') + '\n');

console.log(`::error::release-please cannot parse the commit this PR would create: ${detail}`);
process.exit(1);
