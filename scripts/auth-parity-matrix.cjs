#!/usr/bin/env node
'use strict';
/**
 * auth-parity-matrix.cjs -- executable signature for the provider-auth
 * "fail-open credential handler" defect class.
 *
 * CLASS: a provider auth handler accepts an absent, empty or malformed
 * credential input and proceeds -- degrading to ambient/instance credentials,
 * to a different auth scheme, or to a silently skipped environment variable --
 * instead of failing closed. Equivalently: a validation applied in one handler
 * (or in ONE BRANCH of one handler) is absent from its siblings. Issue #97
 * reopened precisely because its fix hardened `mapAuthorizationScheme` and the
 * ServicePrincipal branch while the WIF branch of the same file kept reading
 * `serviceprincipalid` as optional behind a non-null assertion.
 *
 * The unit of enumeration is therefore (handler x auth-branch x required-field),
 * NOT (file x line). This script discovers every provider command handler in the
 * repo, enumerates the branches inside each one, and prints a verdict for every
 * cell. It is repo-agnostic -- it keys off `*-command-handler.ts` under
 * `Tasks/<...>/src/`, so it runs unchanged in azure-pipelines-packer and in
 * azure-pipelines-terraform.
 *
 *   node scripts/auth-parity-matrix.cjs [repoRoot] [--json] [--quiet]
 *
 * Exit 0 = every cell is GUARDED or EXEMPT. Exit 1 = at least one UNGUARDED cell.
 *
 * Cell kinds:
 *   <fieldName>               a service-connection field read by an accessor.
 *                             GUARDED when the read fails closed on absence AND
 *                             (the field is a secret, or its value is run through
 *                             a validating helper before it becomes an env var).
 *   authorizationScheme       the auth-scheme mapper must throw on an absent
 *                             scheme, never default to one (#97).
 *   competing-credential-env  a branch that injects credentials must first clear
 *                             the env vars of the schemes it is NOT using, or an
 *                             ambient/passthrough value out-ranks it (#187).
 *   credential-delivery-channel
 *                             a branch that delivers a secret as a `PKR_VAR_`
 *                             must also fail closed when the template never
 *                             declares that variable -- packer drops an
 *                             undeclared `PKR_VAR_` silently, so the credential
 *                             never arrives and the build authenticates as the
 *                             agent's ambient identity instead (#332).
 *   roleSessionName           a federated session name must be derived from job
 *                             context, not a fixed constant (#197).
 *   serviceConnection         an empty service connection must fail closed, never
 *                             silently skip the credential block or POST an empty id.
 *   required-in-fallback      an `optional=false` accessor inside an `|| ''` chain
 *                             hard-fails a legitimately-absent optional field and
 *                             leaves an unreachable tail (#194).
 *   no-credentials            a handler that injects nothing must say so with a
 *                             `@credential-exempt` marker.
 *
 * A cell is EXEMPT only when the code carries a machine-readable
 * `@credential-exempt: <reason>` marker in (or immediately above) the enclosing
 * branch. Exemptions are thus code-verified and enumerated, never implicit.
 *
 * PER-REPO DATA PLANE -- SPECIFIED HERE, DELIBERATELY NOT IMPLEMENTED.
 *
 * This gate carries no data file and reads none. It was measured before that
 * was decided: the only table that could plausibly differ per repository,
 * `FAILCLOSED_CREDENTIAL_ENV`, is already the UNION of both extensions'
 * vocabularies, and running the union against each repo's own narrow table
 * changes nothing in either direction (21 failclosed cells on packer, 27 on
 * terraform, identical sets both ways -- the other extension's names
 * manufactured no cell). `ACCESSORS`, `GUARD_HELPERS`, `SECRET_KEY_RE`,
 * `VERIFIERS`, `SIGNATURE_TOGGLE` and `FAIL_VERDICTS` are identical in every
 * copy. There is nothing left to externalise, and a data file that exists
 * without differing is one more thing to drift.
 *
 * The contract is written down anyway, because the day a gate DOES need it the
 * shape should already be settled rather than invented under pressure:
 *
 *   <root>/.security-gates/auth-parity-matrix.json
 *   {
 *     "credentialEnv":  ["PKR_VAR_new_provider_secret"],
 *     "deliveryGuards": ["assertTemplateDeclaresVariable"]
 *   }
 *
 *   - Resolved from ROOT (argv), NEVER from `__dirname`. That is not a style
 *     preference: lib/package-delegation.js records the fabricated sites a
 *     `__dirname` boundary produced the last time a gate was resolved from
 *     outside the tree it analyses.
 *   - Values are UNIONED into the tables below, never substituted. The two keys
 *     union in OPPOSITE directions, and that asymmetry is the whole safety
 *     argument:
 *       `credentialEnv` STRENGTHENS -- a name absent from a repo's code is never
 *         matched, so a union can only ADD cells. Safe for the analysed repo to
 *         write.
 *       `deliveryGuards` WEAKENS -- a guard name absent from a repo's code
 *         leaves its cell UNGUARDED, so a union can only turn UNGUARDED into
 *         GUARDED. Measured second-order damage: an over-broad entry also flips
 *         EXEMPT cells to GUARDED, which erases the `@credential-exempt` markers
 *         from the adapter's enumerated exemption note -- a weakening lever does
 *         not merely hide a finding, it deletes the record that an exemption was
 *         ever claimed. So it must NOT be repo-writable.
 *   - Hence the placement when this lands: `remediation/gates/data/<gate>.json`
 *     keyed by repo name, central and beside the logic. The root-relative path
 *     above is the declared upgrade path for the day a gate runs from a
 *     shared-workflows composite in an extension's own CI, with no access to
 *     security-orchestration. Same JSON either way.
 *   - ABSENT file == the defaults below, byte-for-byte. A file that EXISTS and
 *     cannot be parsed is exit 2, never a silent default: both replay adapters
 *     die() on any exit other than 0/1, so a typo must surface as could-not-run
 *     rather than as a clean repository.
 *
 * Tooling note: `rg` and `ast-grep` do not exist in this project's
 * non-interactive shell (exit 127), so this signature is dependency-free node.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--')) || process.cwd());

// --- discovery -------------------------------------------------------------

/**
 * Every `*-command-handler.ts` under any Tasks/<task>/<version>/src directory,
 * and the count of `.ts` files that population was filtered out of. That count
 * is the denominator: without it, "this repo has no auth handlers" and "this
 * walk started at the wrong directory" are the same answer.
 */
function discoverHandlers(root) {
    const found = [];
    let scanned = 0;
    const tasksDir = path.join(root, 'Tasks');
    if (!fs.existsSync(tasksDir)) return { found, scanned };
    const walk = (dir, depth) => {
        if (depth > 6) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (e.isFile() && path.basename(dir) === 'src' && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
                scanned += 1;
                if (/-command-handler\.ts$/.test(e.name)) found.push(full);
            }
        }
    };
    walk(tasksDir, 0);
    return { found: found.sort(), scanned };
}

// --- lexing helpers --------------------------------------------------------

/** Blanks out comments (preserving offsets/newlines) so code scans never match prose. */
function stripComments(src) {
    let out = '';
    let i = 0;
    let state = 'code'; // code | line | block | sq | dq | tpl
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (state === 'code') {
            if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
            if (c === "'") state = 'sq';
            else if (c === '"') state = 'dq';
            else if (c === '`') state = 'tpl';
            out += c; i++; continue;
        }
        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += c; } else out += ' ';
            i++; continue;
        }
        if (state === 'block') {
            if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
            out += (c === '\n' ? '\n' : ' '); i++; continue;
        }
        if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
        out += c; i++;
    }
    return out;
}

/**
 * Blanks string/template literal BODIES (offsets preserved). Used only for brace
 * arithmetic: a literal like `'${'` in an injection-pattern denylist would
 * otherwise unbalance the depth counter and mislabel every method after it.
 */
function blankStrings(src) {
    let out = '';
    let quote = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { out += '  '; i++; continue; }
            if (c === quote) { quote = null; out += c; continue; }
            out += (c === '\n' ? '\n' : ' ');
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
        out += c;
    }
    return out;
}

function lineStartsOf(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    return starts;
}

function lineOf(starts, offset) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1; // 1-based
}

/** Returns the raw argument text of the call whose '(' is at `open`. */
function callArgs(src, open) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return src.slice(open + 1, i); }
    }
    return null;
}

function splitArgs(text) {
    const out = [];
    let depth = 0, cur = '', quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) { cur += ch; if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function unquote(s) {
    if (!s) return s;
    const m = /^['"`](.*)['"`]$/.exec(s.trim());
    return m ? m[1] : s.trim();
}

// --- scope map (method x branch, per line) ---------------------------------

const METHOD_RE = /^\s*(?:export\s+)?(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*$/;
const CASE_RE = /\bcase\s+AuthorizationScheme\.(\w+)\s*:/;
const WIF_IF_RE = /\bif\s*\(\s*(?:authScheme|authorizationScheme)\s*===\s*["']WorkloadIdentityFederation["']\s*\)/;

/**
 * Assigns every line a (method, branch) label. `branch` is the nearest enclosing
 * `case AuthorizationScheme.X`, else the WIF conditional block, else the method
 * name -- i.e. the auth-branch axis of the matrix.
 */
function scopeMap(code) {
    const lines = code.split('\n');
    const braceLines = blankStrings(code).split('\n');
    const scopes = new Array(lines.length + 1).fill(null);
    let depth = 0;
    let method = null, methodDepth = -1;
    let brCase = null, brCaseDepth = -1;
    let wifDepth = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (methodDepth >= 0 && depth <= methodDepth) { method = null; methodDepth = -1; }
        if (brCaseDepth >= 0 && depth < brCaseDepth) { brCase = null; brCaseDepth = -1; }
        if (wifDepth >= 0 && depth <= wifDepth) wifDepth = -1;
        // `} else {` closes the WIF block: the else arm is the static branch.
        if (wifDepth >= 0 && depth === wifDepth + 1 && /^\s*\}\s*else\b/.test(line)) wifDepth = -1;

        const mCase = CASE_RE.exec(line);
        if (mCase) { brCase = mCase[1]; brCaseDepth = depth; }

        const mMethod = METHOD_RE.exec(line);
        if (mMethod && depth <= 1 && !/\b(if|for|while|switch|catch|return|new)\b/.test(mMethod[1])) {
            method = mMethod[1]; methodDepth = depth;
        }

        const opensWif = WIF_IF_RE.test(line);
        const branch = brCase || (wifDepth >= 0 ? 'WorkloadIdentityFederation' : null) || method || '<top>';
        scopes[i + 1] = { method: method || '<top>', branch };

        for (const ch of braceLines[i] || '') {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
        }
        if (opensWif) wifDepth = depth - 1;
    }
    return scopes;
}

/** Contiguous line runs per (method, branch) -- a branch region. */
function branchRegions(scopes) {
    const regions = [];
    let cur = null;
    for (let ln = 1; ln < scopes.length; ln++) {
        const s = scopes[ln];
        if (!s) continue;
        if (cur && cur.method === s.method && cur.branch === s.branch) { cur.hi = ln; continue; }
        cur = { method: s.method, branch: s.branch, lo: ln, hi: ln };
        regions.push(cur);
    }
    return regions;
}

/** All lines carrying an `@credential-exempt:` marker, with their reason text. */
function exemptionMarkers(rawSrc) {
    const out = [];
    const lines = rawSrc.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /@credential-exempt:\s*(.+?)\s*$/.exec(lines[i]);
        if (m) out.push({ line: i + 1, reason: m[1].replace(/\*\/\s*$/, '').trim() });
    }
    return out;
}

// --- the matrix ------------------------------------------------------------

const ACCESSORS = {
    getEndpointAuthorizationParameter: { keyArg: 1, optArg: 2 },
    getEndpointDataParameter: { keyArg: 1, optArg: 2 },
    getEndpointAuthorizationScheme: { keyArg: null, optArg: 1 },
    getEndpointUrl: { keyArg: null, optArg: 1 },
};

/** Helpers that fail closed on a missing/malformed value before it is injected. */
const GUARD_HELPERS = [
    'requireIdentityField', 'requireSecretField', 'requireField', 'assertIdentityValue',
    'assertGoogleTokenUri', 'validateOciTenancyOcid', 'validateOciRegion', 'validateAndEscapeOciParUrl',
];

/** Fields whose VALUE is opaque: presence is the only checkable property. */
const SECRET_KEY_RE = /(password|secret|privatekey|key$|accesstoken|token|jwt)/i;

/**
 * Environment variable NAMES a handler sets that carry a credential or an
 * identity selector for provider/backend authentication (#1029 finding 4
 * reopen). `EnvironmentVariableHelper.setEnvironmentVariable()` grew a
 * `required` fourth parameter that throws on an empty value instead of
 * degrading to a warning, specifically so the fail-closed guarantee does not
 * rest on every caller remembering (or keeping) an upstream guard -- but the
 * flag is opt-in, and the 2026-09-05 blind re-audit found that none of the
 * ~74 credential-bearing call sites across both extensions passed it. Every
 * `setEnvironmentVariable("<name>", ...)` call for one of these names must
 * pass a literal `true` as its fourth argument, else it is UNGUARDED.
 *
 * This is the CANONICAL copy (remediation/gates/auth-parity-matrix.cjs),
 * resolved by gatelib for every repo the provider-auth-failclosed adapter
 * runs against -- so the set below is the UNION of azure-pipelines-terraform's
 * ARM_ and TF_VAR_ and GOOGLE_ and OCI_CLI_ names and azure-pipelines-packer's
 * PKR_VAR_ and GOOGLE_APPLICATION_CREDENTIALS and PACKER_GITHUB_API_TOKEN
 * names: the two extensions authenticate to the same providers under
 * different SDK-mandated variable names (azurerm's PKR_VAR_arm_client_id has
 * no relation to ARM_CLIENT_ID beyond meaning the same credential), and this
 * one script answers for both repos' own scripts/auth-parity-matrix.cjs
 * copies as well as any repo carrying neither (a name absent from a repo's
 * code is simply never matched -- adding a name from the OTHER extension's
 * vocabulary can never manufacture a false cell).
 *
 * Deliberately EXCLUDED -- not a credential, so not in this set:
 *   - ARM_SUBSCRIPTION_ID / PKR_VAR_arm_subscription_id: names the TARGET
 *     subscription/resource scope, not a credential; already only set inside
 *     `if (subscriptionId)` after assertIdentityValue.
 *   - ARM_USE_CLI / ARM_USE_MSI / ARM_USE_OIDC: fixed literal flags
 *     ("true"/"false"), never operator/connection input.
 *   - AWS_REGION / TF_VAR_region / PKR_VAR_oci_region / GOOGLE_PROJECT:
 *     region/project identifiers, not credentials.
 *   - AWS_ROLE_SESSION_NAME: a per-run CloudTrail-attribution string (#197's
 *     own class), not a credential.
 *   - TF_CLOUD_ORGANIZATION / TF_WORKSPACE: non-secret HCP Terraform config,
 *     each already guarded by its own `if (x && x.trim())`.
 *   - OCI_CLI_PROFILE / OCI_CLI_AUTH / PKR_VAR_oci_access_cfg_file_account /
 *     PKR_VAR_vsphere_insecure_connection: fixed literal constants/flags
 *     ("DEFAULT" / "security_token" / "true"), never operator or connection
 *     input.
 */
const FAILCLOSED_CREDENTIAL_ENV = new Set([
    // azure-pipelines-terraform
    'ARM_CLIENT_ID', 'ARM_CLIENT_SECRET', 'ARM_TENANT_ID', 'ARM_OIDC_TOKEN',
    'ARM_OIDC_REQUEST_TOKEN', 'ARM_OIDC_REQUEST_URL',
    'ARM_ADO_PIPELINE_SERVICE_CONNECTION_ID', 'ARM_OIDC_AZURE_SERVICE_CONNECTION_ID',
    'GOOGLE_CREDENTIALS', 'GOOGLE_BACKEND_CREDENTIALS',
    'OCI_CLI_CONFIG_FILE',
    'TF_VAR_tenancy_ocid', 'TF_VAR_user_ocid', 'TF_VAR_fingerprint', 'TF_VAR_private_key_path',
    'TF_TOKEN_app_terraform_io',
    // azure-pipelines-packer
    'PKR_VAR_arm_client_id', 'PKR_VAR_arm_client_secret', 'PKR_VAR_arm_client_jwt', 'PKR_VAR_arm_tenant_id',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'PKR_VAR_oci_access_cfg_file', 'PKR_VAR_oci_tenancy_ocid', 'PKR_VAR_oci_user_ocid',
    'PKR_VAR_oci_fingerprint', 'PKR_VAR_oci_key_file',
    'PKR_VAR_vsphere_server', 'PKR_VAR_vsphere_user', 'PKR_VAR_vsphere_password',
    'PACKER_GITHUB_API_TOKEN',
    // shared by both extensions
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE',
]);

function analyzeHandler(file, root) {
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const code = stripComments(raw);
    const codeLines = code.split('\n');
    const starts = lineStartsOf(code);
    const scopes = scopeMap(code);
    const regions = branchRegions(scopes);
    const markers = exemptionMarkers(raw);
    const rel = path.relative(root, file).split(path.sep).join('/');
    const base = path.basename(file);
    const handler = base.replace(/-(?:packer|terraform)-command-handler\.ts$/, '');
    const isBase = /^base-/.test(base);
    const cells = [];

    const regionFor = (line) => regions.find((r) => line >= r.lo && line <= r.hi) || { lo: line, hi: line };
    const regionText = (line, pad = 0) => {
        const r = regionFor(line);
        return codeLines.slice(r.lo - 1, Math.min(codeLines.length, r.hi + pad)).join('\n');
    };
    const exemptionFor = (line) => {
        const r = regionFor(line);
        const hit = markers.find((m) => m.line >= r.lo - 14 && m.line <= r.hi);
        return hit ? hit.reason : null;
    };
    // A marker anywhere in [region.lo, region.hi] -- no lookback. exemptionFor()
    // deliberately reaches 14 lines ABOVE a region so a marker can sit above the
    // read it describes, but that leaks across adjacent `case` arms when one
    // branch is short: a marker just inside a preceding branch can fall within
    // the next branch's lookback window and silently EXEMPT a genuinely
    // unguarded cell in that sibling branch (caught by mutation testing the
    // failclosed-set cells below on the packer copy of this script -- the
    // ManagedServiceIdentity marker exempted a mutated WorkloadIdentityFederation
    // cell). Cell kinds whose exemption must not cross a branch boundary pass
    // strictExempt.
    const strictExemptionFor = (line) => {
        const r = regionFor(line);
        const hit = markers.find((m) => m.line >= r.lo && m.line <= r.hi);
        return hit ? hit.reason : null;
    };

    const add = (cellName, verdict, detail, line, branchOverride, strictExempt) => {
        const sc = scopes[line] || { method: '<top>', branch: '<top>' };
        const branch = branchOverride || sc.branch;
        const lookup = strictExempt ? strictExemptionFor : exemptionFor;
        const exempt = verdict === 'UNGUARDED' ? lookup(line) : null;
        cells.push({
            file: rel, handler, branch, cell: cellName,
            site: `${handler}.${branch}.${cellName}`,
            verdict: exempt ? 'EXEMPT' : verdict,
            detail: exempt ? `exempt: ${exempt}` : detail,
            line,
        });
    };

    // ---- 0. Does this file's auth-scheme mapper fail closed? (#97)
    let schemeMapperGuarded = null;
    const declIdx = code.search(/(?:private|function)\s+mapAuthorizationScheme\s*\(/);
    if (declIdx >= 0) {
        const body = code.slice(declIdx, declIdx + 2600);
        const undefGuard = /if\s*\(\s*(?:!\s*\w+|\w+\s*===\s*undefined)[^)]*\)\s*\{([\s\S]{0,1600}?)\n\s*\}/.exec(body);
        let verdict, detail;
        if (!undefGuard) { verdict = 'UNGUARDED'; detail = 'mapper has no absent-scheme guard at all'; }
        else if (/\bthrow\b/.test(undefGuard[1])) { verdict = 'GUARDED'; detail = 'absent scheme throws'; }
        else { verdict = 'UNGUARDED'; detail = 'absent scheme silently defaults to a scheme (warning only)'; }
        schemeMapperGuarded = verdict === 'GUARDED';
        add('authorizationScheme', verdict, detail, lineOf(starts, declIdx), 'schemeResolution');
    }

    // ---- 1. FIELD cells: every raw service-connection accessor read.
    for (const [fn, meta] of Object.entries(ACCESSORS)) {
        const re = new RegExp(`tasks\\.${fn}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(code))) {
            const open = m.index + m[0].length - 1;
            const argText = callArgs(code, open);
            if (argText === null) continue;
            const args = splitArgs(argText);
            const key = meta.keyArg === null
                ? fn.replace('getEndpointAuthorization', '').replace('getEndpoint', '').toLowerCase()
                : unquote(args[meta.keyArg] || '?');
            const opt = (args[meta.optArg] || '').trim();
            const line = lineOf(starts, m.index);
            const tail = code.slice(m.index, m.index + argText.length + 80);
            const inFallbackChain = /\)\s*(\|\||\?\?)\s*(''|""|``)/.test(tail);

            // #194: a required accessor inside a fallback chain hard-fails a
            // legitimately-absent optional field, and its tail is unreachable.
            if (opt === 'false' && inFallbackChain) {
                add('required-in-fallback', 'UNGUARDED',
                    `optional=false accessor for '${key}' inside an || '' chain: the tail is unreachable and an absent optional field hard-fails`,
                    line);
            }

            // The accessor may sit on a continuation line of a multi-line
            // declaration (`const x =` / an `||` fallback chain / a wrapping
            // guard call), so walk back over statement-continuation lines.
            let declLine = codeLines[line - 1] || '';
            let decl = null;
            for (let back = 0; back < 4 && line - 1 - back >= 0; back++) {
                const candidate = codeLines[line - 1 - back] || '';
                decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(candidate)
                    || /^\s*([A-Za-z_$][\w$]*)\s*:\s*tasks\./.exec(candidate)
                    || /^\s*(\w+)\s*=\s*tasks\./.exec(candidate);
                if (decl) { declLine = candidate + '\n' + declLine; break; }
                if (/;\s*$/.test(candidate.trim())) break; // previous statement ended
            }
            const varName = decl ? decl[1] : null;
            const region = regionText(line, 30);
            const validated = varName && GUARD_HELPERS.some((h) =>
                new RegExp(`${h}\\s*\\([^;]*?\\b${varName}\\b`).test(region));
            const presenceChecked = varName
                && new RegExp(`if\\s*\\([^)]*!\\s*${varName}\\b[^)]*\\)\\s*\\{?[\\s\\S]{0,500}?throw`).test(region);
            // Value validation is only required when the value ITSELF becomes an
            // injected credential. A field that is merely parsed into something
            // else (an endpoint URL -> host) is validated on the derived value.
            const injected = varName
                ? new RegExp(`(?:setEnvironmentVariable|backendConfig\\.set)\\s*\\([^;]*?\\b${varName}\\b`).test(region)
                : /setEnvironmentVariable\s*\(|backendConfig\.set\s*\(/.test(declLine);

            // The scheme read is guarded by the mapper it is handed to.
            const isSchemeRead = fn === 'getEndpointAuthorizationScheme';

            let verdict, detail;
            if (isSchemeRead) {
                verdict = schemeMapperGuarded ? 'GUARDED' : 'UNGUARDED';
                detail = schemeMapperGuarded
                    ? 'handed to a fail-closed mapAuthorizationScheme()'
                    : 'optional read handed to a mapper that defaults instead of throwing';
            } else if (opt !== 'false' && !presenceChecked && !validated) {
                verdict = 'UNGUARDED';
                detail = inFallbackChain
                    ? `optional read with || '' -> env var silently skipped on absence`
                    : 'optional read, no fail-closed check (non-null assertion hides it)';
            } else if (!SECRET_KEY_RE.test(key) && injected && !validated) {
                verdict = 'UNGUARDED';
                detail = 'presence-guarded but the value is injected without charset/format validation';
            } else {
                verdict = 'GUARDED';
                const why = SECRET_KEY_RE.test(key)
                    ? 'secret field (value is opaque; presence is the checkable property)'
                    : 'value is not injected directly (validated on the derived value)';
                detail = validated
                    ? 'presence + value validated before injection'
                    : `${why}, ${opt === 'false' ? 'accessor optional=false (task-lib throws)' : 'explicit fail-closed throw'}`;
            }
            add(key, verdict, detail, line);
        }
    }

    // ---- 2. HELPER cells: reads routed through a validating require* helper.
    for (const fn of GUARD_HELPERS) {
        const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(code))) {
            const pre = code.slice(Math.max(0, m.index - 70), m.index);
            if (/(function|private|public|protected|export)\s+$/.test(pre)) continue;
            const argText = callArgs(code, m.index + m[0].length - 1);
            if (argText === null) continue;
            const args = splitArgs(argText);
            const quoted = args.find((a) => /^['"]/.test(a));
            if (!quoted) continue; // value-only validators are counted on the field cell
            add(unquote(quoted), 'GUARDED', `validated via ${fn}()`, lineOf(starts, m.index));
        }
    }

    // ---- 3. NEUTRALIZE cells: every credential branch must clear the env vars
    //         of the auth schemes it is NOT using (the #187 shape: WIF defeated
    //         by ambient/passthrough static keys that the branch never clears).
    if (!isBase) {
        for (const r of regions) {
            if (r.branch === '<top>') continue;
            const region = codeLines.slice(r.lo - 1, r.hi).join('\n');
            if (!/setEnvironmentVariable\s*\(/.test(region)) continue;
            const ok = /neutralizeEnvironmentVariables\s*\(/.test(region);
            add('competing-credential-env', ok ? 'GUARDED' : 'UNGUARDED',
                ok ? 'clears competing auth-scheme env vars before injecting'
                   : 'injects credentials without clearing competing/ambient auth env vars',
                r.lo, r.branch);
        }
    }

    // ---- 3b. DELIVERY cells: a credential injected as PKR_VAR_ must be
    //          accompanied by something that fails closed when the template does
    //          not declare it (#332).
    //
    //          Every other cell kind here asks whether a value was READ safely.
    //          None of them asks whether it ARRIVES. Packer silently ignores a
    //          PKR_VAR_ naming a variable the template never declared -- exit 0,
    //          no diagnostic, not even on `validate` -- and for Azure a dropped
    //          credential leaves packer-plugin-azure's UseMSI() true, so the build
    //          authenticates as the agent VM's managed identity rather than
    //          failing. The matrix reported 44/44 GUARDED throughout, because it
    //          was blind to the delivery channel. That is the same shape as a green
    //          class gate certifying a live high.
    //
    //          Two things satisfy this cell:
    //            - assertTemplateDeclaresVariable(...) -- the `packer inspect`
    //              pre-flight, which refuses when the declaration is absent; or
    //            - providerVarArgs.push(...) -- delivery as `-var`, which packer
    //              itself hard-errors on for an undeclared variable.
    //
    //          Scoped to SECRET-shaped PKR_VAR_ names on purpose: a dropped
    //          non-secret selector (subscription id, region) is a wrong-target or
    //          fail-closed outcome, not a wrong-identity one, and several are
    //          legitimately optional.
    if (!isBase) {
        const SECRET_VAR_RE = /setEnvironmentVariable\s*\(\s*["'](PKR_VAR_[A-Za-z0-9_]*(?:secret|jwt|password|token|privatekey|key_file)[A-Za-z0-9_]*)["']/gi;
        for (const r of regions) {
            if (r.branch === '<top>') continue;
            const region = codeLines.slice(r.lo - 1, r.hi).join('\n');
            SECRET_VAR_RE.lastIndex = 0;
            const delivered = [];
            let m;
            while ((m = SECRET_VAR_RE.exec(region)) !== null) delivered.push(m[1]);
            if (!delivered.length) continue;
            const ok = /assertTemplateDeclaresVariable\s*\(/.test(region)
                || /providerVarArgs\.push\s*\(/.test(region);
            add('credential-delivery-channel', ok ? 'GUARDED' : 'UNGUARDED',
                ok ? `${delivered.join(', ')} delivered with a declaration pre-flight or via -var`
                   : `${delivered.join(', ')} delivered as PKR_VAR_ with nothing failing closed when the template omits the declaration`,
                r.lo, r.branch, /* strictExempt */ true);
        }
    }

    // ---- 4. SESSION cells: a constant role-session-name collapses CloudTrail
    //         attribution across every federated build (#197).
    {
        const re = /(?:AWS_ROLE_SESSION_NAME"\s*,\s*|\bsessionName\s*:\s*)([^\n]*)/g;
        let m;
        while ((m = re.exec(code))) {
            const expr = m[1].trim();
            if (/^string\b/.test(expr)) continue; // interface member, not a value
            // A bare parameter/property reference is the SINK of a value the caller
            // already resolved; the caller's own cell carries the verdict.
            if (/^[A-Za-z_$][\w$.]*\s*\)?\s*[;,]?$/.test(expr)) continue;
            const ok = /resolveRoleSessionName\s*\(/.test(expr);
            add('roleSessionName', ok ? 'GUARDED' : 'UNGUARDED',
                ok ? 'derived from job context + charset-validated'
                   : `fixed constant fallback: ${expr.slice(0, 60)}`,
                lineOf(starts, m.index));
        }
    }

    // ---- 5. CONNECTION cells: a missing service connection must fail closed,
    //         never silently skip the whole credential block or POST an empty id.
    if (!isBase) {
        for (let i = 0; i < codeLines.length; i++) {
            if (!/if\s*\(\s*(?:command\.)?serviceProviderName\s*\)/.test(codeLines[i])) continue;
            const after = codeLines.slice(i, i + 60).join('\n');
            const ok = /\}\s*else\s*\{[\s\S]{0,300}?throw/.test(after);
            add('serviceConnection', ok ? 'GUARDED' : 'UNGUARDED',
                ok ? 'missing service connection throws'
                   : 'missing service connection silently skips the credential block',
                i + 1);
        }
        // WIF paths that hand `command.serviceProviderName` straight to the ADO
        // OIDC endpoint. A named parameter is excluded: it has already crossed a
        // function boundary whose caller owns the check.
        const oidcRe = /(?:generateIdToken|writeOidcTokenFile|applyWifEnvironment|writeWifCredentials)\s*\(/g;
        let m;
        while ((m = oidcRe.exec(code))) {
            const pre = code.slice(Math.max(0, m.index - 90), m.index);
            if (/(private|public|protected|function)\s+(async\s+)?$/.test(pre)) continue;
            const argText = callArgs(code, m.index + m[0].length - 1) || '';
            if (!/(^|[\s:,{])command\.serviceProviderName/.test(argText)) continue;
            const line = lineOf(starts, m.index);
            const r = regionFor(line);
            const region = codeLines.slice(r.lo - 1, line).join('\n');
            const ok = /if\s*\(\s*!\s*(?:command\.)?serviceProviderName\s*\)[\s\S]{0,300}?throw/.test(region);
            add('serviceConnection', ok ? 'GUARDED' : 'UNGUARDED',
                ok ? 'empty service connection throws before the OIDC request'
                   : 'empty service connection reaches the OIDC/credential request unchecked',
                line);
        }
    }

    // ---- 6a. FAILCLOSED-SET cells: a credential-bearing setEnvironmentVariable()
    //          call must pass required:true (4th arg, literal `true`) so the
    //          helper itself throws on an empty value instead of degrading to a
    //          warning -- the fix for #1029's reopen ("the fourth parameter
    //          exists and no caller uses it").
    {
        const re = /\bsetEnvironmentVariable\s*\(/g;
        let m;
        while ((m = re.exec(code))) {
            const argText = callArgs(code, m.index + m[0].length - 1);
            if (argText === null) continue;
            const args = splitArgs(argText);
            const name = unquote(args[0] || '');
            if (!FAILCLOSED_CREDENTIAL_ENV.has(name)) continue;
            const line = lineOf(starts, m.index);
            const required = (args[3] || '').trim() === 'true';
            add(`failclosed:${name}`, required ? 'GUARDED' : 'UNGUARDED',
                required ? 'passes required:true -- an empty value now throws'
                         : `credential-bearing name '${name}' set without required:true -- an empty value degrades to a warning (#1029)`,
                line, undefined, /* strictExempt */ true);
        }
    }

    // ---- 6. Handlers with no credential cells at all must say so explicitly.
    if (!isBase && cells.length === 0) {
        const reason = markers.length ? markers[0].reason : null;
        cells.push({
            file: rel, handler, branch: 'handleProvider', cell: 'no-credentials',
            site: `${handler}.handleProvider.no-credentials`,
            verdict: reason ? 'EXEMPT' : 'UNGUARDED',
            detail: reason ? `exempt: ${reason}` : 'handler injects no credentials and carries no @credential-exempt marker',
            line: 1,
        });
    }

    return cells;
}

// --- run -------------------------------------------------------------------

const { found: handlers, scanned } = discoverHandlers(ROOT);
let cells = [];
for (const f of handlers) cells = cells.concat(analyzeHandler(f, ROOT));

// A site may be reported by more than one detector; keep the strictest verdict.
const bySite = new Map();
for (const c of cells) {
    const k = `${c.file}|${c.site}|${c.line}`;
    const prev = bySite.get(k);
    if (!prev || (prev.verdict !== 'UNGUARDED' && c.verdict === 'UNGUARDED')) bySite.set(k, c);
}
cells = [...bySite.values()].sort((a, b) => (a.file + a.site).localeCompare(b.file + b.site) || a.line - b.line);

const unguarded = cells.filter((c) => c.verdict === 'UNGUARDED');

if (AS_JSON) {
    console.log(JSON.stringify({ root: ROOT, handlerFiles: handlers.length, scanned, cells, unguarded: unguarded.length }, null, 2));
} else if (!QUIET) {
    console.log(`auth-parity-matrix: ${handlers.length} handler file(s) under ${ROOT}, out of ${scanned} source file(s) read`);
    console.log('');
    const w = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(`${w('HANDLER', 9)} ${w('BRANCH', 30)} ${w('FIELD/CELL', 26)} ${w('VERDICT', 9)} ${w('LINE', 5)} DETAIL`);
    console.log('-'.repeat(155));
    for (const c of cells) {
        console.log(`${w(c.handler, 9)} ${w(c.branch, 30)} ${w(c.cell, 26)} ${w(c.verdict, 9)} ${w(c.line, 5)} ${c.detail}`);
    }
    console.log('');
    const g = cells.filter((c) => c.verdict === 'GUARDED').length;
    const e = cells.filter((c) => c.verdict === 'EXEMPT').length;
    console.log(`cells: ${cells.length}  GUARDED: ${g}  EXEMPT: ${e}  UNGUARDED: ${unguarded.length}`);
}

process.exit(unguarded.length ? 1 : 0);
