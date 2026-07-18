import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { Result, SummaryEntry } from 'terraform-drift-contract';
import { replaceSecretFile } from './secure-temp';

interface SarifMessage { text: string; }
interface SarifRule { id: string; name: string; shortDescription: SarifMessage; }
interface SarifLogicalLocation { fullyQualifiedName: string; kind: string; }
interface SarifResult {
    ruleId: string;
    ruleIndex: number;
    level: 'warning';
    message: SarifMessage;
    locations: Array<{ logicalLocations: SarifLogicalLocation[] }>;
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
const SARIF_TOOL_NAME = 'TerraformDriftReport';
const SARIF_INFO_URI = 'https://github.com/sethbacon/azure-pipelines-terraform';

/** Derives a stable rule id from a resource's planned actions. */
function ruleIdForActions(actions: string[]): string {
    const set = new Set(actions);
    if (set.has('create') && set.has('delete')) return 'terraform-drift/replace';
    if (set.has('create')) return 'terraform-drift/create';
    if (set.has('delete')) return 'terraform-drift/delete';
    if (set.has('update')) return 'terraform-drift/update';
    return 'terraform-drift/change';
}

/** One-line description of a changed resource, naming changed attributes when known. */
function describe(entry: SummaryEntry): string {
    const actions = entry.actions.join('+') || 'change';
    if (entry.attrs && entry.attrs.length > 0) {
        const names = entry.attrs.map(a => a.name).join(', ');
        return `${entry.address}: ${actions} (${names})`;
    }
    return `${entry.address}: ${actions}`;
}

/** Builds a SARIF 2.1.0 document from a drift summary (one result per changed resource). */
export function buildDriftSarif(result: Result): SarifLog {
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

    const results: SarifResult[] = result.summary.map(entry => {
        const ruleId = ruleIdForActions(entry.actions);
        return {
            ruleId,
            ruleIndex: ensureRule(ruleId),
            level: 'warning' as const,
            message: { text: describe(entry) },
            locations: [{ logicalLocations: [{ fullyQualifiedName: entry.address, kind: 'resource' }] }]
        };
    });

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
 * Writes a SARIF 2.1.0 report and returns its path. The report names drifted
 * resource addresses and changed-attribute names, so -- like the drift-summary
 * file in index.ts -- it is written via the shared writeSecretFile/
 * replaceSecretFile primitives (owner-only 0600 + O_EXCL on Unix, a restrictive
 * DACL on Windows; see secure-temp.ts) instead of a permission-less
 * fs.writeFileSync. replaceSecretFile is used rather than writeSecretFile
 * because sarifPath may be a user-named, predictable path (e.g. a fixed
 * staging-directory location) that a re-run legitimately overwrites; when no
 * sarifPath is given the auto-generated UUID path has nothing pre-existing to
 * overwrite, so it behaves identically to an exclusive create.
 */
export function writeSarif(result: Result, sarifPath?: string): string {
    const outPath = sarifPath && sarifPath.trim().length > 0
        ? path.resolve(sarifPath)
        : path.join(os.tmpdir(), `tsm-drift-report-${uuidV4()}.sarif`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    replaceSecretFile(outPath, JSON.stringify(buildDriftSarif(result), null, 2));
    return outPath;
}
