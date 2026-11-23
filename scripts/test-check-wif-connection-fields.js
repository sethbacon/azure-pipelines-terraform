#!/usr/bin/env node
'use strict';
// Self-test for check-wif-connection-fields.js: proves each of its three
// assertions fires (a required field, an undeclared built-in required field, a
// secret field that is not confidential), that its scope derivation fails
// rather than shrinking when an auth-scheme input cannot be paired, and that a
// connection type no task can drive in WIF mode is left alone. A gate that
// silently passed any of these would report green while the #1301 / #1302 form
// defect came back.
//
// Each case writes a minimal repo -- one task.json and one
// azure-devops-extension.json -- under a scratch directory and runs the real
// script against it via its [repoRoot] argument.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, 'check-wif-connection-fields.js');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-wif-connection-fields-selftest-'));
let failed = false;
let caseCounter = 0;

const JWT = 'ms.vss-endpoint.endpoint-auth-scheme-JWT';
const NONE = 'ms.vss-endpoint.endpoint-auth-scheme-none';

function optional(id, extra = {}) {
    return { id, name: id, inputMode: 'textbox', isConfidential: false, validation: { isRequired: false, dataType: 'string' }, ...extra };
}
function secret(id, extra = {}) {
    return optional(id, { inputMode: 'textarea', isConfidential: true, ...extra });
}

// The passing shape: a JWT connection that declares PrivateKey, and a
// connection-level field, all optional, the secret confidential.
function goodEndpoint() {
    return {
        name: 'GoodEndpoint',
        authenticationSchemes: [{ type: JWT, inputDescriptors: [optional('Issuer'), optional('Audience'), secret('PrivateKey')] }],
        inputDescriptors: [optional('project')],
    };
}

function wifInputs(prefix, cloud, type, connectionName) {
    return [
        { name: connectionName || `${prefix}ServiceName${cloud}`, type: `connectedService:${type}` },
        { name: `${prefix}AuthScheme${cloud}`, type: 'pickList', options: { ServiceConnection: 'Service connection', WorkloadIdentityFederation: 'WIF' } },
    ];
}

function buildRepo({ inputs, endpoints }) {
    caseCounter += 1;
    const dir = path.join(scratchDir, `case-${caseCounter}`);
    fs.mkdirSync(path.join(dir, 'Tasks', 'Fam', 'FamV1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Tasks', 'Fam', 'FamV1', 'task.json'), JSON.stringify({ inputs }, null, 2));
    const contributions = endpoints.map((properties, i) => ({ id: `endpoint-${i}`, type: 'ms.vss-endpoint.service-endpoint-type', properties }));
    fs.writeFileSync(path.join(dir, 'azure-devops-extension.json'), JSON.stringify({ contributions }, null, 2));
    return dir;
}

function expect(label, repo, { status, includes }) {
    const res = spawnSync(process.execPath, [script, repo], { encoding: 'utf8' });
    const out = `${res.stdout}${res.stderr}`;
    const missing = (includes || []).filter((s) => !out.includes(s));
    if ((status === 0 ? res.status !== 0 : res.status === 0) || missing.length) {
        console.error(`FAIL: ${label}`);
        console.error(`  status=${res.status}${missing.length ? `, output lacks ${JSON.stringify(missing)}` : ''}`);
        console.error(out.replace(/^/gm, '  '));
        failed = true;
    } else {
        console.log(`OK: ${label}`);
    }
}

try {
    expect('passes when the WIF-capable connection requires nothing and keeps its secret confidential',
        buildRepo({ inputs: wifInputs('environment', 'GCP', 'GoodEndpoint'), endpoints: [goodEndpoint()] }),
        { status: 0, includes: ['1 WIF-capable connection type(s) (GoodEndpoint)'] });

    {
        const ep = goodEndpoint();
        ep.authenticationSchemes[0].inputDescriptors[0].validation.isRequired = true;
        expect('fails on a required auth-scheme field',
            buildRepo({ inputs: wifInputs('environment', 'GCP', 'GoodEndpoint'), endpoints: [ep] }),
            { status: 1, includes: [`field 'Issuer' (${JWT}) is required`] });
    }

    {
        const ep = goodEndpoint();
        ep.inputDescriptors[0].validation.isRequired = 'true';
        expect('fails on a required connection-level field, including the string form "true"',
            buildRepo({ inputs: wifInputs('environment', 'GCP', 'GoodEndpoint'), endpoints: [ep] }),
            { status: 1, includes: ["field 'project' (connection) is required"] });
    }

    {
        const ep = goodEndpoint();
        ep.authenticationSchemes[0].inputDescriptors.pop();
        expect('fails when the JWT scheme leaves PrivateKey to the built-in required definition (#1301)',
            buildRepo({ inputs: wifInputs('environment', 'GCP', 'GoodEndpoint'), endpoints: [ep] }),
            { status: 1, includes: [`auth scheme ${JWT} does not declare 'PrivateKey'`] });
    }

    {
        const ep = goodEndpoint();
        ep.authenticationSchemes[0].inputDescriptors[2].isConfidential = false;
        expect('fails when the declared PrivateKey is not confidential',
            buildRepo({ inputs: wifInputs('environment', 'GCP', 'GoodEndpoint'), endpoints: [ep] }),
            { status: 1, includes: ["secret field 'PrivateKey'", 'not isConfidential'] });
    }

    {
        const ep = { name: 'OciLike', authenticationSchemes: [{ type: NONE, inputDescriptors: [secret('privatekey', { validation: { isRequired: true } })] }], inputDescriptors: [optional('tenancy')] };
        expect('fails on a required secret under a scheme with no built-in defaults (#1302)',
            buildRepo({ inputs: wifInputs('environment', 'OCI', 'OciLike'), endpoints: [ep] }),
            { status: 1, includes: [`field 'privatekey' (${NONE}) is required`] });
    }

    {
        const strict = { name: 'KeyOnly', authenticationSchemes: [{ type: NONE, inputDescriptors: [optional('apiKey', { validation: { isRequired: true } })] }] };
        const inputs = [...wifInputs('environment', 'GCP', 'GoodEndpoint'), { name: 'keyOnlyService', type: 'connectedService:KeyOnly' }];
        expect('ignores a required field on a connection type no task can drive in WIF mode',
            buildRepo({ inputs, endpoints: [goodEndpoint(), strict] }),
            { status: 0, includes: ['1 WIF-capable connection type(s) (GoodEndpoint)'] });
    }

    {
        const inputs = [{ name: 'environmentAuthSchemeGCP', type: 'pickList', options: { WorkloadIdentityFederation: 'WIF' } }];
        expect('fails when a WIF auth-scheme input pairs with no connection input',
            buildRepo({ inputs, endpoints: [goodEndpoint()] }),
            { status: 1, includes: ["input 'environmentAuthSchemeGCP' offers WorkloadIdentityFederation but pairs with 0"] });
    }

    {
        const inputs = [...wifInputs('environment', 'GCP', 'GoodEndpoint'), { name: 'environmentOtherServiceGCP', type: 'connectedService:GoodEndpoint' }];
        expect('fails when a WIF auth-scheme input pairs with two connection inputs',
            buildRepo({ inputs, endpoints: [goodEndpoint()] }),
            { status: 1, includes: ['pairs with 2'] });
    }

    {
        const inputs = [{ name: 'gcpMode', type: 'pickList', options: { WorkloadIdentityFederation: 'WIF' } }];
        expect('fails when a WIF input is not named <prefix>AuthScheme<Cloud>',
            buildRepo({ inputs, endpoints: [goodEndpoint()] }),
            { status: 1, includes: ["input 'gcpMode' offers WorkloadIdentityFederation but is not named"] });
    }

    expect('fails when the paired connection type is not defined by the manifest',
        buildRepo({ inputs: wifInputs('backend', 'GCP', 'MissingEndpoint', 'backendServiceGCP'), endpoints: [goodEndpoint()] }),
        { status: 1, includes: ['MissingEndpoint: selected for WIF by', 'defines no'] });

    expect('fails when no task input offers WIF at all',
        buildRepo({ inputs: [{ name: 'environmentServiceNameGCP', type: 'connectedService:GoodEndpoint' }], endpoints: [goodEndpoint()] }),
        { status: 1, includes: ['the gate enumerated NOTHING'] });
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('test-check-wif-connection-fields FAILED');
    process.exit(1);
}
console.log('test-check-wif-connection-fields: all cases passed.');
