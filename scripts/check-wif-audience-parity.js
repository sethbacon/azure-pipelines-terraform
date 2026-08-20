#!/usr/bin/env node
'use strict';
/**
 * check-wif-audience-parity.js -- one token, one audience, four guides.
 *
 * CLASS: a value that MUST be identical across several documents because a
 * single code path produces it, but which is maintained by hand in each one.
 *
 * Tasks/TerraformTask/TerraformTaskV5/src/id-token-generator.ts requests the
 * federated token with only the service-connection id and sets NO custom
 * audience, so Azure DevOps issues its default-audience OIDC JWT -- and that
 * one requester is reused for Azure, AWS, GCP and OCI by design. The four
 * relying parties are therefore configured to expect the SAME audience. Any
 * guide naming a different one instructs the operator to build a trust that
 * rejects the only token this extension can mint.
 *
 * That is not hypothetical: #965 was filed because aws/gcp/oci-wif-setup.md
 * all said `api://AzureADTokenV2` while azure-wif-setup.md said
 * `api://AzureADTokenExchange`. Azure DevOps mints the latter, so following
 * the three non-Azure guides as written produced a hard auth failure on
 * first use. Nothing compared the four documents, so the divergence survived.
 *
 * This gate does not assert WHICH audience is correct -- the value lives in
 * Azure DevOps, not in this repo, and hard-coding it here would be a second
 * unverified declaration. It asserts that the guides AGREE, which is the
 * property the shared requester actually guarantees, and that each guide
 * names one at all.
 *
 *   node scripts/check-wif-audience-parity.js [repoRoot]
 *
 * Exit 0 = every guide names exactly one audience and all agree.
 * Exit 1 = a divergence, a guide naming none, or no guides found.
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const dir = path.join(root, 'docs', 'setup');
const AUDIENCE = /api:\/\/[A-Za-z0-9._-]+/g;

const errors = [];
let guides = [];
try {
    guides = fs.readdirSync(dir).filter((f) => /-wif-setup\.md$/.test(f)).sort();
} catch (e) {
    console.error(`check-wif-audience-parity: cannot read ${dir}: ${e.message}`);
    process.exit(1);
}

// An empty universe is a red flag, not a pass: if the guides move or are
// renamed, this gate must say it examined nothing rather than report clean.
if (guides.length === 0) {
    console.error(`check-wif-audience-parity: no *-wif-setup.md under ${dir} -- the gate enumerated NOTHING, which is not the same as agreement.`);
    process.exit(1);
}

const seen = new Map(); // audience -> [guides]
for (const g of guides) {
    const text = fs.readFileSync(path.join(dir, g), 'utf8');
    const found = [...new Set(text.match(AUDIENCE) || [])];
    if (found.length === 0) {
        errors.push(`${g}: names no api:// audience at all. An operator following it cannot configure the relying party's expected audience.`);
        continue;
    }
    if (found.length > 1) {
        errors.push(`${g}: names ${found.length} different audiences (${found.join(', ')}). One requester mints one token; a guide cannot need two.`);
    }
    for (const a of found) {
        if (!seen.has(a)) seen.set(a, []);
        seen.get(a).push(g);
    }
}

if (seen.size > 1) {
    const lines = [...seen.entries()].map(([a, gs]) => `    ${a}  <-- ${gs.join(', ')}`).join('\n');
    errors.push(
        `the guides disagree about the audience, but one code path mints the token for all of them:\n${lines}\n` +
        `    id-token-generator.ts sets no custom audience, so every cloud receives the SAME token. At most one of these values can work.`
    );
}

console.log(`enumerated: ${guides.length} WIF setup guide(s) (${guides.join(', ')}), ${seen.size} distinct audience(s).`);
if (errors.length) {
    console.error('check-wif-audience-parity FAILED:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
}
console.log(`OK: all ${guides.length} guides name the same audience (${[...seen.keys()][0]}).`);
