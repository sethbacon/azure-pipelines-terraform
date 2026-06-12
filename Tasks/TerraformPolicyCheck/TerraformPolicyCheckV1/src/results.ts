import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { PolicyCase } from './types';

/** Persists raw engine output and returns its path (exposed as resultsFilePath). */
export function writeResultsFile(rawOutput: string): string {
    const resultsPath = path.join(os.tmpdir(), `policy-results-${uuidV4()}.txt`);
    fs.writeFileSync(resultsPath, rawOutput, 'utf-8');
    return resultsPath;
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Writes a JUnit XML report (one test case per policy/rule) and returns its path. */
export function writeJUnit(cases: PolicyCase[], engine: string): string {
    const failures = cases.filter(c => !c.passed).length;
    const suiteName = `Terraform Policy Check (${engine})`;

    const body = cases.map(c => {
        const open = `    <testcase classname="${xmlEscape(suiteName)}" name="${xmlEscape(c.name)}">`;
        if (c.passed) {
            return `${open}</testcase>`;
        }
        const message = xmlEscape(c.message || `Policy ${c.name} failed`);
        return `${open}\n      <failure message="${message}">${message}</failure>\n    </testcase>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${xmlEscape(suiteName)}" tests="${cases.length}" failures="${failures}">
${body}
  </testsuite>
</testsuites>
`;

    const xmlPath = path.join(os.tmpdir(), `policy-junit-${uuidV4()}.xml`);
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    return xmlPath;
}

/** Publishes the JUnit XML so policy outcomes appear in the pipeline Tests tab. */
export function publishJUnit(xmlPath: string, engine: string): void {
    tasks.command('results.publish', {
        type: 'JUnit',
        mergeResults: 'true',
        runTitle: `Terraform Policy Check (${engine})`
    }, xmlPath);
}
