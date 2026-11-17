import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { randomUUID as uuidV4 } from 'crypto';
import { writeSecretFile } from '@4cloudguru/pipeline-task-ado';
import { PolicyResult, PolicyCase } from './types';
import { execOpaDecision } from './opa-engine';

/**
 * Evaluates an HCP Terraform OPA policy set as HCP Terraform would
 * (`hcpPolicySet`).
 *
 * The policy source is the root of a policy set: `policies.hcl` lists the
 * policies, each a Rego `query` with an optional `enforcement_level`. HCP
 * Terraform's rules, which this follows:
 *
 *   - The plan is at `input.plan`, not at the top of the input.
 *   - A query must return an array; the policy passes when it is empty.
 *   - `advisory` (the default) never stops the run; `mandatory` does.
 *
 * NOT provided: `input.run` (workspace, organization, run settings). A pipeline
 * has no equivalent for most of it, and inventing values would make a rule that
 * reads them appear to work. A rule that depends on `input.run` is undefined
 * here, so it reports nothing.
 */

const SET_CONFIG = 'policies.hcl';
const ENFORCEMENT_LEVELS: ReadonlySet<string> = new Set(['advisory', 'mandatory']);
const ATTRIBUTES: ReadonlySet<string> = new Set(['query', 'enforcement_level', 'description']);
/** A reference to one rule: `data.<package path>.<rule>`. */
const QUERY_RE = /^data(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
/** The plan JSON is held in memory once to wrap it; a plan larger than this cannot be. */
const MAX_PLAN_JSON_BYTES = 200 * 1024 * 1024;

export interface OpaSetPolicy {
    name: string;
    query: string;
    enforcementLevel: string;
    description?: string;
}

/** `value` is the identifier or the decoded string; empty for punctuation. */
interface Token { kind: 'ident' | 'string' | '{' | '}' | '='; value: string; line: number; }

/**
 * Tokenizes the small part of HCL a `policies.hcl` uses: identifiers, quoted
 * strings, braces, `=`, and the three comment forms. Anything else -- a number,
 * a list, a heredoc, a template -- is an error naming its line, never skipped:
 * a file this reader only half understands must not yield half its policies.
 */
function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;
    const fail = (what: string): never => {
        throw new Error(`${SET_CONFIG} line ${line}: ${what}`);
    };
    while (i < source.length) {
        const c = source[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }
        if (c === '#' || source.startsWith('//', i)) {
            while (i < source.length && source[i] !== '\n') i++;
            continue;
        }
        if (source.startsWith('/*', i)) {
            const end = source.indexOf('*/', i + 2);
            if (end === -1) fail('unterminated /* comment');
            line += source.slice(i, end).split('\n').length - 1;
            i = end + 2;
            continue;
        }
        if (c === '{' || c === '}' || c === '=') { tokens.push({ kind: c, value: '', line }); i++; continue; }
        if (c === '"') {
            let value = '';
            i++;
            for (; ; i++) {
                if (i >= source.length || source[i] === '\n') fail('unterminated string');
                const ch = source[i];
                if (ch === '"') { i++; break; }
                if (ch === '\\') {
                    const escaped = source[++i];
                    const map: ReadonlyMap<string, string> = new Map([['"', '"'], ['\\', '\\'], ['n', '\n'], ['t', '\t'], ['r', '\r']]);
                    const replacement = map.get(escaped);
                    if (replacement === undefined) fail(`unsupported escape '\\${escaped ?? ''}' in a string`);
                    value += replacement;
                    continue;
                }
                if ((ch === '$' || ch === '%') && source[i + 1] === '{') fail('template expressions are not supported in a string');
                value += ch;
            }
            tokens.push({ kind: 'string', value, line });
            continue;
        }
        const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i, i + 256));
        if (ident) { tokens.push({ kind: 'ident', value: ident[0], line }); i += ident[0].length; continue; }
        fail(`unexpected '${c}'; only policy blocks with quoted string attributes are supported`);
    }
    return tokens;
}

/**
 * Reads a `policies.hcl`:
 *
 *     policy "<name>" {
 *       query             = "data.<package>.<rule>"
 *       enforcement_level = "advisory" | "mandatory"   # optional, advisory by default
 *       description       = "..."                      # optional
 *     }
 */
export function parsePoliciesFile(source: string): OpaSetPolicy[] {
    const tokens = tokenize(source);
    const policies: OpaSetPolicy[] = [];
    const names = new Set<string>();
    let i = 0;
    const lineAt = (index: number): number => (tokens[index] ?? tokens[tokens.length - 1]).line;
    const fail = (index: number, what: string): never => {
        throw new Error(`${SET_CONFIG} line ${lineAt(index)}: ${what}`);
    };
    const expect = (kind: Token['kind'], what: string): Token => {
        const token = tokens[i];
        if (!token || token.kind !== kind) fail(i, `expected ${what}`);
        i++;
        return token;
    };

    while (i < tokens.length) {
        const keyword = expect('ident', 'a policy block');
        if (keyword.value !== 'policy') fail(i - 1, `unsupported block '${keyword.value}'; only policy blocks are supported`);
        const name = expect('string', 'the policy name in quotes').value;
        if (!name) fail(i - 1, 'a policy name must not be empty');
        if (names.has(name)) fail(i - 1, `policy '${name}' is declared more than once`);
        names.add(name);
        expect('{', `'{' after policy "${name}"`);

        const attributes = new Map<string, string>();
        while (tokens[i] && tokens[i].kind !== '}') {
            const key = expect('ident', 'an attribute name').value;
            if (!ATTRIBUTES.has(key)) fail(i - 1, `unsupported attribute '${key}' in policy '${name}' (supported: ${[...ATTRIBUTES].join(', ')})`);
            if (attributes.has(key)) fail(i - 1, `attribute '${key}' is set more than once in policy '${name}'`);
            expect('=', `'=' after ${key}`);
            attributes.set(key, expect('string', `a quoted string for ${key}`).value);
        }
        expect('}', `'}' closing policy "${name}"`);

        const query = attributes.get('query');
        if (query === undefined) fail(i - 1, `policy '${name}' has no query`);
        if (!QUERY_RE.test(query!)) {
            fail(i - 1, `policy '${name}' has query '${query}'; a query must reference one rule, as data.<package>.<rule>`);
        }
        const enforcementLevel = attributes.get('enforcement_level') ?? 'advisory';
        if (!ENFORCEMENT_LEVELS.has(enforcementLevel)) {
            fail(i - 1, `policy '${name}' has enforcement_level '${enforcementLevel}'; OPA policies are advisory or mandatory`);
        }
        policies.push({ name, query: query!, enforcementLevel, description: attributes.get('description') });
    }

    if (policies.length === 0) {
        throw new Error(`${SET_CONFIG} declares no policies; refusing to treat an empty policy set as a pass.`);
    }
    return policies;
}

/** `data.terraform.policy1.deny` -> `terraform/policy1/deny`, the form `opa exec --decision` takes. */
export function queryToDecisionPath(query: string): string {
    return query.split('.').slice(1).join('/');
}

/** HCP Terraform's rule for one policy: the query's result must be an array, and an empty one passes. */
export function violationsOf(policy: OpaSetPolicy, decision: unknown): string[] {
    if (!Array.isArray(decision)) {
        throw new Error(
            `Policy '${policy.name}': query ${policy.query} returned ${decision === null ? 'null' : typeof decision} ` +
            `(${JSON.stringify(decision)?.slice(0, 200)}). HCP Terraform requires a query to return an array, which passes when empty.`,
        );
    }
    return decision.map(d => (typeof d === 'string' ? d : JSON.stringify(d)));
}

/**
 * Writes `{"plan": <plan JSON>}` beside nothing else, in the agent's private
 * temp directory, and returns its path. The plan is embedded as text, not parsed
 * and re-serialized: OPA is the one that validates it.
 */
function writeHcpInput(planJsonPath: string, tempFiles: string[]): string {
    const size = fs.statSync(planJsonPath).size;
    if (size > MAX_PLAN_JSON_BYTES) {
        throw new Error(`${planJsonPath} is ${size} bytes; hcpPolicySet can wrap a plan JSON of at most ${MAX_PLAN_JSON_BYTES} bytes.`);
    }
    const inputDir = path.join(tasks.getVariable('Agent.TempDirectory') || os.tmpdir(), `opa-input-${uuidV4()}`);
    tempFiles.push(inputDir);
    fs.mkdirSync(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, 'input.json');
    writeSecretFile(inputPath, `{"plan":${fs.readFileSync(planJsonPath, 'utf-8')}}`);
    return inputPath;
}

export async function runOpaPolicySet(
    opaPath: string,
    policyDir: string,
    inputFile: string,
    tempFiles: string[],
): Promise<PolicyResult> {
    const setConfigPath = path.join(policyDir, SET_CONFIG);
    if (!fs.existsSync(setConfigPath)) {
        throw new Error(
            `hcpPolicySet is enabled but ${setConfigPath} does not exist. The policy source must be the root of an ` +
            `HCP Terraform OPA policy set, which holds ${SET_CONFIG} (use policyRepoSubdir if the set is in a subdirectory).`,
        );
    }
    const policies = parsePoliciesFile(fs.readFileSync(setConfigPath, 'utf-8'));
    const hcpInput = writeHcpInput(inputFile, tempFiles);

    const cases: PolicyCase[] = [];
    const blocking: string[] = [];
    const nonBlocking: string[] = [];
    const rawOutputs: string[] = [];
    for (const policy of policies) {
        const { results, stdout } = await execOpaDecision(opaPath, policyDir, hcpInput, queryToDecisionPath(policy.query));
        rawOutputs.push(stdout);
        const violations = violationsOf(policy, results[0]?.result);
        const level = policy.enforcementLevel;
        console.log(`${violations.length === 0 ? 'PASS' : 'FAIL'} - ${policy.name} [${level}]`);
        if (violations.length === 0) {
            cases.push({ name: policy.name, passed: true, enforcementLevel: level });
            continue;
        }
        cases.push({ name: policy.name, passed: false, enforcementLevel: level, message: `[${level}] ${violations.join('\n')}` });
        for (const violation of violations) {
            (level === 'mandatory' ? blocking : nonBlocking).push(`[${level}] ${policy.name}: ${violation}`);
        }
    }

    for (const v of blocking) tasks.error(v);
    for (const v of nonBlocking) tasks.warning(v);

    return { passed: blocking.length === 0, violations: [...blocking, ...nonBlocking], cases, rawOutput: rawOutputs.join('\n') };
}
