import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { PolicyCase, PolicyResult } from './types';
import { writeSecretFile, replaceSecretFile } from './secure-temp';

/**
 * The agent's private temp directory, purged automatically at job end. Raw engine
 * output (and reports derived from it) can embed Terraform plan resource values,
 * so it must not land in the shared, never-purged os.tmpdir() (issue #487). The
 * files written here are deliberately NOT deleted by this task — later pipeline
 * steps consume them via the resultsFilePath/sarifFilePath output variables; the
 * job-end purge of Agent.TempDirectory is the cleanup mechanism.
 */
function tempDir(): string {
    return tasks.getVariable('Agent.TempDirectory') || os.tmpdir();
}

/**
 * Persists raw engine output and returns its path (exposed as resultsFilePath).
 * The raw output can embed unmasked Terraform plan resource values, so it is
 * written via the shared writeSecretFile primitive: owner-only (0600) + O_EXCL
 * on Unix (defeating a pre-existing-symlink hazard) and an explicit restrictive
 * DACL on Windows (where 0600 is a no-op), both fail closed -- see
 * secure-temp.ts, a byte-identical copy of TerraformTaskV5's module gated by
 * scripts/check-shared-modules.js (#607) -- rather than a bare fs.writeFileSync
 * with a swallowed Windows chmod failure.
 */
export function writeResultsFile(rawOutput: string): string {
    const resultsPath = path.join(tempDir(), `policy-results-${uuidV4()}.txt`);
    writeSecretFile(resultsPath, rawOutput);
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

/**
 * Writes a JUnit XML report (one test case per policy/rule) and returns its
 * path. Failure messages can echo policy-violation detail derived from plan
 * resource values, so this is written via the same writeSecretFile primitive
 * as writeResultsFile above.
 */
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

    const xmlPath = path.join(tempDir(), `policy-junit-${uuidV4()}.xml`);
    writeSecretFile(xmlPath, xml);
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

// --- SARIF 2.1.0 reporting ---

interface SarifMessage { text: string; }
interface SarifRule { id: string; name: string; shortDescription: SarifMessage; }
interface SarifResult {
    ruleId: string;
    ruleIndex: number;
    level: 'error' | 'warning' | 'note';
    message: SarifMessage;
}
interface SarifLog {
    $schema: string;
    version: '2.1.0';
    runs: Array<{
        tool: { driver: { name: string; informationUri: string; rules: SarifRule[] } };
        results: SarifResult[];
    }>;
}

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SARIF_TOOL_NAME = 'TerraformPolicyCheck';
const SARIF_INFO_URI = 'https://github.com/sethbacon/azure-pipelines-terraform';

/** Advisory findings are non-blocking, so map them to warnings; everything else gates. */
function sarifLevel(enforcementLevel?: string): 'error' | 'warning' {
    return enforcementLevel && enforcementLevel.toLowerCase().includes('advisory') ? 'warning' : 'error';
}

/** Builds a SARIF 2.1.0 document from an engine result (one result per violation). */
export function buildPolicySarif(result: PolicyResult, engine: string): SarifLog {
    const rules: SarifRule[] = [];
    const ruleIndexById = new Map<string, number>();
    const ensureRule = (id: string): number => {
        let idx = ruleIndexById.get(id);
        if (idx === undefined) {
            idx = rules.length;
            rules.push({ id, name: id, shortDescription: { text: id } });
            ruleIndexById.set(id, idx);
        }
        return idx;
    };

    // Catalogue every evaluated policy/rule so results reference a known rule.
    for (const c of result.cases) {
        ensureRule(c.name);
    }

    const results: SarifResult[] = [];
    const failedCases = result.cases.filter(c => !c.passed);
    if (failedCases.length > 0) {
        for (const c of failedCases) {
            results.push({
                ruleId: c.name,
                ruleIndex: ensureRule(c.name),
                level: sarifLevel(c.enforcementLevel),
                message: { text: c.message || `Policy ${c.name} failed` }
            });
        }
    } else if (!result.passed) {
        // Failure without a per-rule breakdown (e.g. Sentinel output without parseable
        // PASS/FAIL lines): surface each violation under an engine-level rule.
        const fallbackRuleId = `${engine}-policy-violation`;
        for (const v of result.violations) {
            results.push({
                ruleId: fallbackRuleId,
                ruleIndex: ensureRule(fallbackRuleId),
                level: 'error',
                message: { text: v }
            });
        }
    }

    return {
        $schema: SARIF_SCHEMA,
        version: '2.1.0',
        runs: [{
            tool: { driver: { name: SARIF_TOOL_NAME, informationUri: SARIF_INFO_URI, rules } },
            results
        }]
    };
}

/**
 * Writes a SARIF 2.1.0 report and returns its path. The report names failed
 * policy/rule identifiers and violation messages, so -- like writeResultsFile
 * and writeJUnit above -- it is written via the shared writeSecretFile/
 * replaceSecretFile primitives (owner-only 0600 + O_EXCL on Unix, a
 * restrictive DACL on Windows; see secure-temp.ts) instead of a
 * permission-less fs.writeFileSync. replaceSecretFile is used rather than
 * writeSecretFile because sarifPath may be a user-named, predictable path
 * (e.g. a fixed staging-directory location) that a re-run legitimately
 * overwrites; when no sarifPath is given the auto-generated UUID path has
 * nothing pre-existing to overwrite, so it behaves identically to an
 * exclusive create.
 */
export function writeSarif(result: PolicyResult, engine: string, sarifPath?: string): string {
    const explicitPath = sarifPath && sarifPath.trim().length > 0;
    const outPath = explicitPath
        ? path.resolve(sarifPath!)
        : path.join(tempDir(), `policy-results-${uuidV4()}.sarif`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const json = JSON.stringify(buildPolicySarif(result, engine), null, 2);
    replaceSecretFile(outPath, json);
    return outPath;
}
