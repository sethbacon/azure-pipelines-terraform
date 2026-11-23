#!/usr/bin/env node
'use strict';
/**
 * check-wif-connection-fields.js -- a connection used for WIF must not demand
 * credentials WIF never reads.
 *
 * CLASS: a service connection type that a task can drive in Workload Identity
 * Federation mode, whose form still REQUIRES a static credential field. The
 * auth mode is chosen by a task input (`<prefix>AuthScheme<Cloud>`), not on the
 * connection, so the form cannot make a field conditional on WIF: a required
 * field is required for every connection of that type, and a WIF user has to
 * invent a value -- for a secret field, paste a fake secret -- to save one.
 *
 * That is not hypothetical: #1301 (GCP: the JWT scheme's PrivateKey) and #1302
 * (OCI: privatekey, user, tenancy, region, fingerprint) were both filed after
 * AWS had already been fixed by hand in 1073e7b. Nothing enumerated the class,
 * so each connection type was fixed only when someone tripped over it.
 *
 * Loosening the form loses no check. Each handler's static branch reads these
 * fields through the fail-closed guards in credential-guards.ts, which stop the
 * run when a value is empty (held there by the shared auth-parity-matrix gate).
 *
 * What this gate asserts, for every connection type some task input can select
 * WIF for:
 *
 *   1. no input descriptor -- on the connection or on any of its auth schemes --
 *      is `isRequired`;
 *   2. no field Azure DevOps supplies ITSELF for a built-in auth scheme is left
 *      undeclared, because the built-in definition is required (#1301: the JWT
 *      scheme's PrivateKey was never declared, so the form fell back to it);
 *   3. every secret-named field stays `isConfidential`. Declaring a field to
 *      make it optional REPLACES Azure DevOps's own definition, so dropping the
 *      flag there would store a private key as a plain field.
 *
 * The scope is derived, not listed: a `pickList` input offering
 * `WorkloadIdentityFederation`, named `<prefix>AuthScheme<Cloud>`, selects for
 * the one `connectedService:<Type>` input in the same task.json named
 * `<prefix>...<Cloud>`. An auth-scheme input that pairs with no connection
 * input, or with several, fails rather than dropping out of scope.
 *
 *   node scripts/check-wif-connection-fields.js [repoRoot]
 *
 * Exit 0 = every WIF-capable connection type satisfies 1-3.
 * Exit 1 = a violation, an unpairable auth-scheme input, or nothing enumerated.
 */
const fs = require('fs');
const path = require('path');
const { discoverTaskDirs } = require('./lib/task-dirs');

const root = process.argv[2] || path.resolve(__dirname, '..');
const WIF = 'WorkloadIdentityFederation';
const AUTH_SCHEME_INPUT = /^(.+)AuthScheme(.+)$/;
const CONNECTED_SERVICE = 'connectedService:';
const ENDPOINT_TYPE = 'ms.vss-endpoint.service-endpoint-type';
const SECRET_ID = /private.?key|secret|password/i;

// Fields Azure DevOps adds to a built-in auth scheme as REQUIRED unless the
// manifest declares them. Only defaults observed in a live form are listed:
// 2026-11-23, a JWT connection whose manifest declared only Issuer and
// Audience still demanded a Private key (#1301).
const BUILT_IN_REQUIRED = new Map([
    ['ms.vss-endpoint.endpoint-auth-scheme-JWT', ['PrivateKey']],
]);

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function isRequired(descriptor) {
    const flag = descriptor.validation && descriptor.validation.isRequired;
    return flag === true || flag === 'true';
}

const errors = [];

// connection type -> the task inputs that can select WIF for it
const wifTypes = new Map();
for (const dir of discoverTaskDirs(root)) {
    const taskJson = `${dir}/task.json`;
    const inputs = readJson(path.join(root, taskJson)).inputs || [];
    const connections = inputs.filter((i) => typeof i.type === 'string' && i.type.startsWith(CONNECTED_SERVICE));
    const schemes = inputs.filter((i) => i.type === 'pickList' && i.options && Object.keys(i.options).includes(WIF));
    for (const scheme of schemes) {
        const m = AUTH_SCHEME_INPUT.exec(scheme.name);
        if (!m) {
            errors.push(`${taskJson}: input '${scheme.name}' offers ${WIF} but is not named <prefix>AuthScheme<Cloud>, so the gate cannot tell which connection input it selects for.`);
            continue;
        }
        const [, prefix, cloud] = m;
        const paired = connections.filter((c) => c.name.startsWith(prefix) && c.name.endsWith(cloud));
        if (paired.length !== 1) {
            const found = paired.length ? paired.map((c) => `'${c.name}'`).join(', ') : 'none';
            errors.push(`${taskJson}: input '${scheme.name}' offers ${WIF} but pairs with ${paired.length} connectedService inputs named ${prefix}...${cloud} (${found}); expected exactly one.`);
            continue;
        }
        const type = paired[0].type.slice(CONNECTED_SERVICE.length);
        if (!wifTypes.has(type)) wifTypes.set(type, []);
        wifTypes.get(type).push(`${taskJson} ${scheme.name}`);
    }
}

// An empty universe is a red flag, not a pass: if the auth-scheme inputs are
// renamed or moved, this gate must say it examined nothing.
if (wifTypes.size === 0 && errors.length === 0) {
    errors.push(`no task input under ${path.join(root, 'Tasks')} offers ${WIF} -- the gate enumerated NOTHING, which is not the same as a clean result.`);
}

const manifest = readJson(path.join(root, 'azure-devops-extension.json'));
const endpoints = new Map();
for (const c of manifest.contributions || []) {
    if (c.type === ENDPOINT_TYPE && c.properties && c.properties.name) endpoints.set(c.properties.name, c.properties);
}

for (const [type, selectedBy] of wifTypes) {
    const endpoint = endpoints.get(type);
    if (!endpoint) {
        errors.push(`${type}: selected for WIF by ${selectedBy.join(', ')}, but azure-devops-extension.json defines no ${ENDPOINT_TYPE} of that name.`);
        continue;
    }
    const fields = (endpoint.inputDescriptors || []).map((d) => ({ where: 'connection', d }));
    for (const scheme of endpoint.authenticationSchemes || []) {
        const declared = scheme.inputDescriptors || [];
        for (const d of declared) fields.push({ where: scheme.type, d });
        for (const id of BUILT_IN_REQUIRED.get(scheme.type) || []) {
            if (!declared.some((d) => d.id === id)) {
                errors.push(`${type}: auth scheme ${scheme.type} does not declare '${id}', so Azure DevOps shows its own definition of that field, which is required. Declare it with validation.isRequired false.`);
            }
        }
    }
    for (const { where, d } of fields) {
        if (isRequired(d)) {
            errors.push(`${type}: field '${d.id}' (${where}) is required, but WIF mode never reads it. Set validation.isRequired to false; the static branch's fail-closed guard still stops a run without it.`);
        }
        if (SECRET_ID.test(d.id) && d.isConfidential !== true) {
            errors.push(`${type}: secret field '${d.id}' (${where}) is not isConfidential, so Azure DevOps would store it as a plain field.`);
        }
    }
}

const names = [...wifTypes.keys()];
console.log(`enumerated: ${names.length} WIF-capable connection type(s)${names.length ? ` (${names.join(', ')})` : ''}.`);
if (errors.length) {
    console.error('check-wif-connection-fields FAILED:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
}
console.log('OK: no WIF-capable connection type requires a field, leaves a built-in required field undeclared, or exposes a secret field.');
