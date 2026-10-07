#!/usr/bin/env node
'use strict';

// Validates the YAML examples in the documentation against the tasks they
// document.
//
// docs/yaml-examples.md is a contract: operators copy its snippets into
// pipelines. Azure Pipelines silently ignores an input a task does not declare,
// and a task silently ignores an input its visibleRule hides, so a snippet can
// rot -- a renamed input, a changed default, an option that was removed -- with
// nothing failing anywhere. This gate makes the examples fail the build instead.
//
// What it checks, per documentation file:
//
//   Syntax       every ```yaml block parses (strict subset reader,
//                scripts/lib/pipeline-yaml.js).
//   Examples     every task step names a task and major version that exist;
//                every input exists on that task; pick-list inputs hold one of
//                their options; boolean inputs hold true or false; every
//                required input is present; no input is one its own visibleRule
//                hides; inputs of type password are never literals.
//   Behaviour    rules the schema cannot express (see STEP_RULES): applying a
//                saved plan with planning-only inputs, a show file read by a
//                later step while cleanup is on, a test filter that is not a
//                file, diagnostics options without their switch.
//   References   $(step.var) and variables['step.var'] resolve, within the same
//                H2 section, to a step defined earlier and to an output
//                variable that step's task declares.
//   Prose        relative links and #anchors resolve; anchors that other files
//                (source, task strings, other docs) cite exist; "(default `x`)"
//                claims and "# default" / "# a | b | c" comments match
//                task.json; backticked task names exist; deprecated tasks carry
//                a deprecation notice in their section and table of contents.
//   Completeness every input of every task appears in an example (see
//                NOT_EXEMPLIFIED), every pick-list option is mentioned, the
//                dimension inputs in EXEMPLIFY_EACH_OPTION are shown with each
//                option, every output variable is mentioned, and every task has
//                a heading and a table-of-contents link.
//
// What it does not do: judge prose. It does not prove an example is a good
// idea, only that it is one the task schema and the rules above accept.
//
// visibleRule is evaluated at the input level only. Group-level rules are a UI
// affordance (the backend* inputs are legitimately read on state commands from
// a provider-grouped form), so they are not evaluated. A value that is a
// variable or expression ($(x), ${{ x }}) is unknown and never fails a rule.
//
// Dependency-free (Node stdlib only) and read-only: it runs in the
// check-versions job, which does no `npm ci`. Exit status is 1 on any problem.
//
// Usage: node scripts/check-yaml-examples.js [--root <dir>] [<doc.md> ...]
//        (default document: docs/yaml-examples.md; coverage is computed over
//        all documents named)

const fs = require('fs');
const path = require('path');
const { discoverTaskDirs } = require('./lib/task-dirs.js');
const { parseYaml, YamlError } = require('./lib/pipeline-yaml.js');

const DEFAULT_DOCS = ['docs/yaml-examples.md'];

// Tasks the examples may use that this repository does not ship. Anything else
// must be a task of this repository, so a mistyped task name fails here instead
// of passing as "external". Add a task here when an example genuinely needs it.
const EXTERNAL_TASKS = new Set(['PublishBuildArtifacts@1', 'PublishPipelineArtifact@1', 'PublishTestResults@2']);

// Inputs a document may legitimately never show in a YAML example, per task id,
// with the reason. Empty: every input of every task is shown.
const NOT_EXEMPLIFIED = new Map();

// Pick-list inputs whose options are an open-ended region list; the document
// describes them as "any region" rather than enumerating them.
const OPEN_OPTION_LISTS = new Set(['awsRegion', 'backendAWSRegion', 'ociWifRegion']);

// Inputs of which every option must appear as a value in at least one example,
// because each option is a different code path an operator can take.
const EXEMPLIFY_EACH_OPTION = new Map([['PipelineTerraformTask@5', ['provider', 'binaryName', 'command', 'backendType']]]);

// visibleRule clauses that exclude a command although it does read the input.
// `terraform test` authenticates against the provider when a connection is
// supplied (and only then), so the connection inputs are meaningful there even
// though the rule hides them.
const WAIVED_CLAUSES = new Map([['PipelineTerraformTask@5', new Set(['command != test'])]]);

// Backend input groups, keyed by the backendType that activates them.
const BACKEND_GROUP_BY_TYPE = new Map([
    ['azurerm', 'backendAzureRm'],
    ['s3', 'backendAWS'],
    ['gcs', 'backendGCP'],
    ['oci', 'backendOCI'],
    ['hcp', 'backendHCP'],
    ['generic', 'backendGeneric'],
]);

// First segments of dotted variable names that are not step names.
const PREDEFINED_VARIABLE_ROOTS = new Set([
    'system', 'build', 'agent', 'pipeline', 'common', 'release', 'environment', 'resources',
    'strategy', 'deployment', 'task', 'variables', 'parameters', 'dependencies', 'stagedependencies',
]);

// Backticked camelCase words in prose that are neither inputs, outputs, options
// nor step names, with the reason.
const PROSE_TOKEN_ALLOWLIST = new Map();

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'build', 'coverage', 'dist', '.terraform']);
const SCAN_EXTENSIONS = new Set(['.md', '.ts', '.json', '.yml', '.yaml', '.resjson']);

const DYNAMIC = Symbol('dynamic');
const isDynamic = (text) => /\$\(|\$\{\{|\$\[/.test(text);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------- tasks ----

// "a = v" / "a != v" clauses joined by && and ||. Anything else is an error:
// silently skipping a rule this gate cannot read would let an example pass
// unchecked.
function parseRule(text) {
    return text.split('||').map((group) =>
        group.split('&&').map((clause) => {
            const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(!=|=)\s*(.*?)\s*$/.exec(clause);
            if (!m) throw new Error(`unsupported visibleRule clause "${clause.trim()}"`);
            return { name: m[1], op: m[2], value: m[3] === '""' ? '' : m[3], text: `${m[1]} ${m[2]} ${m[3]}` };
        }),
    );
}

function normalizeInput(input, where) {
    const properties = input.properties || {};
    let rule = null;
    if (input.visibleRule) {
        try {
            rule = parseRule(input.visibleRule);
        } catch (err) {
            throw new Error(`${where} input "${input.name}": ${err.message}; extend parseRule in scripts/check-yaml-examples.js`);
        }
    }
    return {
        name: input.name,
        type: String(input.type || 'string').toLowerCase(),
        required: input.required === true,
        defaultValue: input.defaultValue === undefined ? undefined : String(input.defaultValue),
        options: input.options && typeof input.options === 'object' ? new Set(Object.keys(input.options)) : null,
        editable: String(properties.EditableOptions).toLowerCase() === 'true',
        group: input.groupName || '',
        rule,
        ruleText: input.visibleRule || '',
    };
}

function loadTasks(root, report) {
    const tasks = new Map();
    for (const dir of discoverTaskDirs(root)) {
        const file = `${dir}/task.json`;
        let json;
        try {
            json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        } catch (err) {
            report(file, 0, `not valid JSON (${err.message})`);
            continue;
        }
        const id = `${json.name}@${json.version && json.version.Major}`;
        if (tasks.has(id)) {
            report(file, 0, `duplicate task id ${id}`);
            continue;
        }
        const inputs = new Map();
        for (const input of json.inputs || []) inputs.set(input.name, normalizeInput(input, file));
        tasks.set(id, {
            id,
            file,
            deprecated: json.deprecated === true,
            inputs,
            outputs: (json.outputVariables || []).map((o) => o.name),
        });
    }
    return tasks;
}

function evaluateRule(rule, eff, waived) {
    let closest = null;
    for (const group of rule) {
        const failed = [];
        for (const clause of group) {
            if (waived && waived.has(clause.text)) continue;
            const actual = eff(clause.name);
            if (actual === DYNAMIC) continue;
            const holds = clause.op === '=' ? actual === clause.value : actual !== clause.value;
            if (!holds) failed.push(clause.op === '=' ? `${clause.name} is "${actual}", not "${clause.value}"` : `${clause.name} is "${actual}"`);
        }
        if (failed.length === 0) return { visible: true, why: [] };
        if (!closest || failed.length < closest.length) closest = failed;
    }
    return { visible: false, why: closest || [] };
}

// A group of backend inputs is only needed on `init`, and only for the backend
// type that selects it. Provider groups are governed by the inputs' own rules.
function groupActive(group, eff) {
    if (!group.startsWith('backend')) return true;
    const command = eff('command');
    const type = eff('backendType');
    if (command === DYNAMIC || type === DYNAMIC) return false;
    return command === 'init' && BACKEND_GROUP_BY_TYPE.get(type) === group;
}

// -------------------------------------------------------------- markdown ----

function cleanHeading(title) {
    let text = title
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Until stable: removing one tag can join the pieces around it into another.
    let previous;
    do {
        previous = text;
        text = text.replace(/<[^>]+>/g, '');
    } while (text !== previous);
    return text.replace(/[`*]/g, '');
}

// GitHub's heading anchor: lower-case, drop everything but letters, digits,
// marks, spaces, hyphens and underscores, then each space becomes a hyphen.
function slugify(title) {
    return cleanHeading(title)
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .replace(/\s/g, '-');
}

function readMarkdown(text) {
    const headings = [];
    const fences = [];
    const prose = [];
    const seen = new Map();
    let fence = null;
    let h2 = null;
    text.split('\n').forEach((raw, idx) => {
        const line = idx + 1;
        const marker = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(raw);
        if (fence) {
            if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && /^ {0,3}(`+|~+)\s*$/.test(raw)) {
                fences.push(fence);
                fence = null;
            } else {
                fence.body.push(raw);
            }
            return;
        }
        if (marker) {
            fence = { lang: marker[2].toLowerCase(), marker: marker[1], line: line + 1, body: [], h2 };
            return;
        }
        const h = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(raw);
        if (h) {
            const base = slugify(h[2]);
            const n = seen.get(base) || 0;
            seen.set(base, n + 1);
            const heading = { level: h[1].length, title: cleanHeading(h[2]).trim(), slug: n === 0 ? base : `${base}-${n}`, line };
            headings.push(heading);
            if (heading.level === 2) h2 = heading;
        }
        prose.push({ line, text: raw, h2 });
    });
    return { headings, fences, prose, unterminated: fence };
}

const stripCode = (text) => text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// ------------------------------------------------------------------ yaml ----

// A mapping with one of these keys is a pipeline step that is not a task step.
const OTHER_STEP_KEYS = ['script', 'bash', 'powershell', 'pwsh', 'checkout', 'download', 'downloadBuild', 'getPackage', 'publish', 'template'];

function collectSteps(node, out) {
    if (node.kind === 'seq') {
        for (const item of node.items) collectSteps(item, out);
        return;
    }
    if (node.kind !== 'map') return;
    const task = node.entries.find((e) => e.key === 'task');
    if (task && task.value.kind === 'scalar' && /^[A-Za-z0-9_.-]+@[0-9]+(\.[0-9]+)*$/.test(task.value.text)) {
        out.push({ map: node, taskEntry: task });
    } else if (node.entries.some((e) => OTHER_STEP_KEYS.includes(e.key))) {
        out.push({ map: node, taskEntry: null });
    }
    for (const e of node.entries) collectSteps(e.value, out);
}

function walkAst(node, onScalar, onKey) {
    if (node.kind === 'scalar') {
        onScalar(node);
    } else if (node.kind === 'seq') {
        node.items.forEach((n) => walkAst(n, onScalar, onKey));
    } else {
        for (const e of node.entries) {
            if (onKey) onKey(e.key);
            walkAst(e.value, onScalar, onKey);
        }
    }
}

function buildStep(found, fence) {
    const lineOf = (n) => fence.line + n - 1;
    const entry = (key) => found.map.entries.find((e) => e.key === key);
    const nameEntry = entry('name');
    const inputsEntry = found.taskEntry ? entry('inputs') : undefined;
    const inputs = new Map();
    let inputsShape = '';
    if (inputsEntry && inputsEntry.value.kind === 'map') {
        for (const e of inputsEntry.value.entries) {
            inputs.set(e.key, { node: e.value, line: lineOf(e.keyLine) });
        }
    } else if (inputsEntry && !(inputsEntry.value.kind === 'scalar' && inputsEntry.value.value === null)) {
        inputsShape = 'inputs must be a mapping of input name to value';
    }
    let id = null;
    if (found.taskEntry) {
        const [name, major] = found.taskEntry.value.text.split('@');
        id = `${name}@${major.split('.')[0]}`;
    }
    const line = lineOf(found.taskEntry ? found.taskEntry.keyLine : found.map.line);
    return {
        id,
        line,
        name: nameEntry && nameEntry.value.kind === 'scalar' ? nameEntry.value.text : null,
        map: found.map,
        inputs,
        inputsShape,
        lineOf,
        has: (n) => inputs.has(n),
        value: (n) => {
            const i = inputs.get(n);
            return i && i.node.kind === 'scalar' ? i.node.text : undefined;
        },
        inputLine: (n) => (inputs.has(n) ? inputs.get(n).line : line),
    };
}

// ------------------------------------------------------- behaviour rules ----

// Rules keyed by task id. Each receives { step, eff, report(line, message) }.
// `report` is already bound to the document.
const SAVED_PLAN_FORBIDDEN_INPUTS = ['varFile', 'secureVarsFile', 'terraformVariables', 'targetResources', 'replaceAddress'];

function ruleSavedPlanApply({ step, eff, report }) {
    if (eff('command') !== 'apply') return;
    const options = step.value('commandOptions') || '';
    const tokens = options.split(/\s+/).filter(Boolean);
    const plan = tokens.find((t) => !t.startsWith('-'));
    if (!plan) return;
    const offending = SAVED_PLAN_FORBIDDEN_INPUTS.filter((n) => step.has(n));
    if (step.value('refreshOnly') === 'true') offending.push('refreshOnly');
    for (const t of tokens) {
        const m = /^-(var|var-file|target|replace|refresh-only|destroy)(=|$)/.exec(t);
        if (m) offending.push(`-${m[1]} in commandOptions`);
    }
    if (offending.length > 0) {
        report(step.inputLine('commandOptions'), `applying the saved plan "${plan}" cannot take ${offending.join(', ')}: Terraform rejects planning options with a saved plan, so pass them to the plan step`);
    }
}

function ruleTestFilter({ step, report }) {
    const v = step.value('testFilter');
    if (v !== undefined && !isDynamic(v) && !/\.tftest\.(hcl|json)$/.test(v)) {
        report(step.inputLine('testFilter'), `testFilter is passed as -filter=<test file>, so it must name a test file such as tests/unit.tftest.hcl, not "${v}"`);
    }
}

function ruleDiagnostics({ step, report }) {
    const detail = step.value('includeDiagnosticDetail') === 'true';
    const diagnostics = step.value('includeDiagnostics') === 'true';
    if (detail && !diagnostics) {
        report(step.inputLine('includeDiagnosticDetail'), 'includeDiagnosticDetail has no effect unless includeDiagnostics is true');
    }
    if ((detail || diagnostics) && !step.value('publishApplyResults')) {
        report(step.inputLine(detail ? 'includeDiagnosticDetail' : 'includeDiagnostics'), 'the diagnostics options are only read when publishApplyResults is set');
    }
}

const STEP_RULES = new Map([['PipelineTerraformTask@5', [ruleSavedPlanApply, ruleTestFilter, ruleDiagnostics]]]);

// Rules for a step that reads an output variable of an earlier step. Receives
// the producing step, the variable, and a bound report for the reading line.
function ruleShowFileConsumed({ producer, variable, report }) {
    if (variable !== 'showFilePath' || producer.value('command') !== 'show') return;
    if (producer.value('cleanupShowFileIfSensitive') !== 'false') {
        report(`"${producer.name}.showFilePath" is read by a later step, but the show step deletes that file when the plan holds sensitive values; set cleanupShowFileIfSensitive: false on it (line ${producer.line})`);
    }
}

const REFERENCE_RULES = new Map([['PipelineTerraformTask@5', [ruleShowFileConsumed]]]);

// ----------------------------------------------------------- step checks ----

const REFERENCE_PATTERNS = [
    /\$\(([A-Za-z_][\w-]*)\.([\w.-]+)\)/g,
    /variables\[\s*['"]([A-Za-z_][\w-]*)\.([\w.-]+)['"]\s*\]/g,
];

function checkStep(ctx, step, section) {
    const { tasks, report, counts } = ctx;
    const at = (line, message) => report(ctx.rel, line, message);
    if (step.id === null) {
        scanReferences(ctx, step, section, at);
        return;
    }
    counts.steps += 1;
    if (step.inputsShape) at(step.line, step.inputsShape);

    const task = tasks.get(step.id);
    if (!task) {
        if (EXTERNAL_TASKS.has(step.id)) {
            counts.external += 1;
        } else {
            const name = step.id.split('@')[0];
            const shipped = [...tasks.keys()].filter((id) => id.split('@')[0] === name);
            at(step.line, shipped.length > 0
                ? `task "${step.id}" does not exist; this repository ships ${shipped.join(', ')}`
                : `task "${step.id}" is neither a task of this repository nor listed in EXTERNAL_TASKS`);
        }
    } else {
        validateInputs(ctx, step, task, at);
    }
    scanReferences(ctx, step, section, at);
    if (task) section.tasks.add(task.id);
}

function validateInputs(ctx, step, task, at) {
    const { counts } = ctx;
    const used = ctx.used.get(task.id) || new Set();
    ctx.used.set(task.id, used);
    const waived = WAIVED_CLAUSES.get(task.id);

    const eff = (name) => {
        const def = task.inputs.get(name);
        let v;
        if (step.has(name)) {
            v = step.value(name);
            if (v === undefined) return DYNAMIC;
        } else {
            v = def && def.defaultValue !== undefined ? def.defaultValue : '';
        }
        if (isDynamic(v)) return DYNAMIC;
        return def && def.type === 'boolean' ? v.toLowerCase() : v;
    };

    for (const [name, given] of step.inputs) {
        const def = task.inputs.get(name);
        counts.inputs += 1;
        if (!def) {
            at(given.line, `"${name}" is not an input of ${task.id}`);
            continue;
        }
        used.add(name);
        if (given.node.kind !== 'scalar') {
            at(given.line, `the value of "${name}" must be a scalar (use a block scalar for several lines)`);
            continue;
        }
        const text = given.node.text;
        const dynamic = isDynamic(text);
        if (def.type === 'password' && !dynamic) {
            at(given.line, `"${name}" is a secret input; show it as a variable such as $(name), never a literal value`);
        }
        if (!dynamic && def.type === 'boolean' && text !== 'true' && text !== 'false') {
            at(given.line, `"${name}" is a boolean input; use true or false, not "${text}"`);
        }
        if (!dynamic && def.options && !def.editable && !def.options.has(text)) {
            at(given.line, `"${text}" is not an option of "${name}" (options: ${[...def.options].join(', ')})`);
        }
        if (def.rule) {
            const result = evaluateRule(def.rule, eff, waived);
            if (!result.visible) {
                at(given.line, `"${name}" has no effect here, its visibleRule is false (${result.why.join('; ')}) [${def.ruleText}]`);
            }
        }
        if (given.node.comment) checkComment(at, given.line, def, text, given.node.comment);
    }

    for (const def of task.inputs.values()) {
        if (!def.required || step.has(def.name)) continue;
        if (def.defaultValue !== undefined && def.defaultValue !== '') continue;
        if (def.group && !groupActive(def.group, eff)) continue;
        if (def.rule && !evaluateRule(def.rule, eff, null).visible) continue;
        at(step.line, `required input "${def.name}" of ${task.id} is missing`);
    }

    for (const rule of STEP_RULES.get(task.id) || []) rule({ step, eff, report: at });
}

// A trailing comment on an input line may assert the input's default or list
// its options; both must match task.json.
function checkComment(at, line, def, text, comment) {
    const list = /^([\w.-]+(?:\s*\|\s*[\w.-]+)+)/.exec(comment);
    if (list) {
        const listed = list[1].split('|').map((s) => s.trim());
        if (!def.options) return;
        const missing = [...def.options].filter((o) => !listed.includes(o));
        const extra = listed.filter((o) => !def.options.has(o));
        if (missing.length > 0 || extra.length > 0) {
            at(line, `the option list in the comment on "${def.name}" differs from task.json (missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'})`);
        }
        return;
    }
    const actual = def.defaultValue === undefined ? '' : def.defaultValue;
    if (/^default\s*(?:[;,.:)]|$)/i.test(comment)) {
        if (text !== actual) at(line, `the comment on "${def.name}" says the value is the default, but the default is "${actual}"`);
        return;
    }
    const claim = /\bdefaults?(?:\s+to|:)?\s+(`[^`]+`|"[^"]+"|'[^']+'|true\b|false\b|\d+\b|[^\s;,)]*[$/.:_-][^\s;,)]*)/i.exec(comment);
    if (claim) {
        const claimed = claim[1].replace(/^[`"']|[`"']$/g, '');
        if (claimed !== actual) at(line, `the comment on "${def.name}" says the default is "${claimed}", but task.json says "${actual}"`);
    }
}

function scanReferences(ctx, step, section, at) {
    const seen = new Set();
    walkAst(step.map, (node) => {
        for (const pattern of REFERENCE_PATTERNS) {
            for (const m of node.text.matchAll(pattern)) {
                const [, stepName, variable] = m;
                const inside = node.text.slice(0, m.index).split('\n').length - 1;
                const line = step.lineOf(node.line + (node.literal ? 1 : 0) + inside);
                const key = `${stepName}.${variable}@${line}`;
                if (seen.has(key) || PREDEFINED_VARIABLE_ROOTS.has(stepName.toLowerCase())) continue;
                seen.add(key);
                ctx.counts.references += 1;
                const producer = section.names.get(stepName);
                if (!producer) {
                    at(line, `"${stepName}.${variable}" refers to a step named "${stepName}" that is not defined earlier in this section`);
                    continue;
                }
                const task = ctx.tasks.get(producer.id);
                if (!task) continue;
                if (!task.outputs.includes(variable)) {
                    at(line, `${producer.id} (step "${stepName}") does not set an output variable "${variable}"${task.outputs.length > 0 ? ` (it sets: ${task.outputs.join(', ')})` : ' (it sets none)'}`);
                    continue;
                }
                for (const rule of REFERENCE_RULES.get(producer.id) || []) rule({ producer, variable, report: (message) => at(line, message) });
            }
        }
    });
}

// ----------------------------------------------------------------- links ----

function headingSlugs(ctx, abs) {
    if (!ctx.slugCache.has(abs)) {
        ctx.slugCache.set(abs, new Set(readMarkdown(fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n')).headings.map((h) => h.slug)));
    }
    return ctx.slugCache.get(abs);
}

function checkLinks(ctx, rel, abs, md) {
    const { root, report, counts } = ctx;
    const own = new Set(md.headings.map((h) => h.slug));
    const linkPattern = /(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    for (const { line, text } of md.prose) {
        const plain = stripCode(text);
        const targets = [...plain.matchAll(linkPattern)].map((m) => m[3]);
        const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(plain);
        if (definition) targets.push(definition[1]);
        for (const target of targets) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
            counts.links += 1;
            const hash = target.indexOf('#');
            const filePart = hash === -1 ? target : target.slice(0, hash);
            const anchor = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
            if (filePart === '') {
                if (anchor && !own.has(anchor)) report(rel, line, `link to #${anchor} has no matching heading in this document`);
                continue;
            }
            const resolved = filePart.startsWith('/') ? path.join(root, filePart) : path.resolve(path.dirname(abs), decodeURIComponent(filePart));
            if (!fs.existsSync(resolved)) {
                report(rel, line, `link target "${filePart}" does not exist`);
            } else if (anchor && resolved.endsWith('.md') && !headingSlugs(ctx, resolved).has(anchor)) {
                report(rel, line, `link to "${filePart}#${anchor}": that file has no such heading`);
            }
        }
    }
}

function* walkFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(full);
        } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
            yield full;
        }
    }
}

// Task error messages and other documents cite headings of the examples
// document by anchor; renaming a heading must not leave those dead.
function checkInboundAnchors(ctx, analyzed) {
    const { root, report, counts } = ctx;
    const byName = new Map(analyzed.map((a) => [path.basename(a.rel), a]));
    const pattern = new RegExp(`(${[...byName.keys()].map(escapeRegExp).join('|')})#([A-Za-z0-9_-]+)`, 'g');
    for (const file of walkFiles(root)) {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes('#')) continue;
        text.split(/\r?\n/).forEach((line, idx) => {
            for (const m of line.matchAll(pattern)) {
                counts.inbound += 1;
                if (!byName.get(m[1]).slugs.has(m[2])) {
                    report(posix(path.relative(root, file)), idx + 1, `cites ${m[1]}#${m[2]}, which is not a heading anchor in that document`);
                }
            }
        });
    }
}

// ----------------------------------------------------------------- prose ----

// Consecutive non-blank prose lines of one section, joined, so a claim that a
// wrapped line splits is still read as one sentence.
function paragraphs(prose) {
    const out = [];
    let current = null;
    for (const p of prose) {
        if (p.text.trim() === '' || /^ {0,3}#{1,6}\s/.test(p.text)) {
            current = null;
            continue;
        }
        if (!current || current.h2 !== p.h2) {
            current = { h2: p.h2, text: '', starts: [] };
            out.push(current);
        }
        current.starts.push({ offset: current.text.length, line: p.line });
        current.text += `${p.text.trim()} `;
    }
    for (const p of out) {
        p.lineAt = (offset) => p.starts.filter((s) => s.offset <= offset).pop().line;
    }
    return out;
}

// "`input` is opt-in (default `x`)", "`input` defaults to `x`", "`input: x` (the default)".
function checkProseDefaults(ctx, md, rel, sections) {
    const { report, tasks } = ctx;
    const claimPatterns = [
        /`([A-Za-z]\w*)`[^`.;|]{0,40}?\((?:the\s+)?defaults?(?:\s+to|:)?\s+(`[^`]+`|[^\s)]+)\)/g,
        /`([A-Za-z]\w*)`\s+defaults?\s+to\s+(`[^`]+`|true\b|false\b|\d+\b|[^\s,;)`]*[$/.:_-][^\s,;)`]*)/g,
        /`([A-Za-z]\w*):\s*([^`]+)`\s*\((?:the\s+)?default\)/g,
    ];
    for (const para of paragraphs(md.prose)) {
        const { text, h2 } = para;
        for (const pattern of claimPatterns) {
            for (const m of text.matchAll(pattern)) {
                const line = para.lineAt(m.index);
                const claimed = m[2].replace(/^[`"']+|[`"'.,]+$/g, '');
                const section = sections.get(h2);
                const scoped = [...(section ? section.tasks : [])].map((id) => tasks.get(id)).filter((t) => t && t.inputs.has(m[1]));
                const candidates = scoped.length > 0 ? scoped : [...tasks.values()].filter((t) => t.inputs.has(m[1]));
                if (candidates.length === 0) continue;
                const actual = candidates.map((t) => (t.inputs.get(m[1]).defaultValue === undefined ? '' : t.inputs.get(m[1]).defaultValue));
                if (!actual.includes(claimed)) {
                    report(rel, line, `the text says the default of "${m[1]}" is "${claimed}", but task.json says ${actual.map((a) => `"${a}"`).join(' / ')}`);
                }
            }
        }
    }
}

function checkProseTokens(ctx, md, rel, knownTokens) {
    const { report, tasks } = ctx;
    for (const { line, text } of md.prose) {
        for (const token of codeSpans(text)) {
            if (/^[A-Za-z0-9]+@[0-9]+$/.test(token)) {
                if (!tasks.has(token) && !EXTERNAL_TASKS.has(token)) report(rel, line, `"${token}" is not a task of this repository (and not in EXTERNAL_TASKS)`);
            } else if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(token) && !knownTokens.has(token) && !PROSE_TOKEN_ALLOWLIST.has(token)) {
                report(rel, line, `"${token}" looks like an input or output name but matches none (renamed or removed?)`);
            }
        }
    }
}

// ------------------------------------------------------------- documents ----

function analyzeDoc(ctx, rel) {
    const { root, tasks, report, counts } = ctx;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
        report(rel, 0, 'documentation file not found');
        return null;
    }
    const md = readMarkdown(fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n'));
    ctx.rel = rel;
    counts.headings += md.headings.length;
    counts.fences += md.fences.length;
    if (md.unterminated) report(rel, md.unterminated.line - 1, 'fenced code block is never closed');

    const sections = new Map();
    const sectionOf = (h2) => {
        if (!sections.has(h2)) sections.set(h2, { names: new Map(), tasks: new Set(), steps: [] });
        return sections.get(h2);
    };
    const yamlTokens = new Set();
    const stepNames = new Set();

    for (const fence of md.fences) {
        if (fence.lang !== 'yaml' && fence.lang !== 'yml') continue;
        counts.yaml += 1;
        let ast;
        try {
            ast = parseYaml(fence.body.join('\n'));
        } catch (err) {
            if (!(err instanceof YamlError)) throw err;
            report(rel, fence.line + err.line - 1, `YAML: ${err.message}`);
            continue;
        }
        walkAst(
            ast,
            (node) => {
                for (const part of node.text.split('\n')) yamlTokens.add(part.trim());
                for (const token of node.comment ? node.comment.split(/[^\w.\-/]+/) : []) yamlTokens.add(token);
            },
            (key) => yamlTokens.add(key),
        );
        const section = sectionOf(fence.h2);
        const found = [];
        collectSteps(ast, found);
        const inFence = new Set();
        for (const f of found) {
            const step = buildStep(f, fence);
            if (step.name !== null) {
                if (inFence.has(step.name)) report(rel, step.line, `step name "${step.name}" is used twice in this example`);
                inFence.add(step.name);
                stepNames.add(step.name);
            }
            checkStep(ctx, step, section);
            section.steps.push(step);
            if (step.name !== null) section.names.set(step.name, step);
        }
    }

    const mentioned = new Set(yamlTokens);
    for (const { text } of md.prose) {
        for (const token of codeSpans(text)) {
            mentioned.add(token);
            for (const part of token.split(/[\s,|]+/)) mentioned.add(part);
        }
    }

    checkLinks(ctx, rel, abs, md);
    return { rel, md, sections, mentioned, yamlTokens, stepNames, slugs: new Set(md.headings.map((h) => h.slug)) };
}

function sectionText(analyzed, h2) {
    return analyzed.md.prose.filter((p) => p.h2 === h2).map((p) => p.text).join('\n');
}

function checkDeprecation(ctx, a) {
    const { tasks, report } = ctx;
    for (const [h2, section] of a.sections) {
        const deprecatedUsed = [...section.tasks].filter((id) => tasks.get(id) && tasks.get(id).deprecated);
        if (deprecatedUsed.length > 0 && !/deprecat/i.test(sectionText(a, h2))) {
            report(a.rel, h2 ? h2.line : 1, `this section uses deprecated task(s) ${deprecatedUsed.join(', ')} but its text never says they are deprecated`);
        }
    }
    for (const task of tasks.values()) {
        if (!task.deprecated) continue;
        const heading = a.md.headings.find((h) => h.title.includes(task.id));
        if (!heading) continue;
        const link = a.md.prose.find((p) => p.text.includes(`](#${heading.slug})`));
        if (link && !/deprecat/i.test(link.text)) {
            report(a.rel, link.line, `the table-of-contents entry for deprecated task ${task.id} does not say it is deprecated`);
        }
    }
}

function checkCompleteness(ctx, analyzed) {
    const { tasks, report } = ctx;
    const primary = analyzed[0].rel;
    const mentioned = new Set();
    const text = [];
    for (const a of analyzed) {
        a.mentioned.forEach((m) => mentioned.add(m));
        text.push(fs.readFileSync(path.join(ctx.root, a.rel), 'utf8'));
    }
    const everything = text.join('\n');
    const headings = analyzed.flatMap((a) => a.md.headings.map((h) => ({ ...h, doc: a })));

    for (const task of tasks.values()) {
        const used = ctx.used.get(task.id) || new Set();
        const exempt = NOT_EXEMPLIFIED.get(task.id) || new Map();
        let shown = 0;
        for (const name of task.inputs.keys()) {
            if (used.has(name)) shown += 1;
            else if (!exempt.has(name)) report(primary, 0, `${task.id}: input "${name}" is never shown in a YAML example`);
        }
        for (const name of exempt.keys()) {
            if (!task.inputs.has(name)) report(primary, 0, `${task.id}: NOT_EXEMPLIFIED lists "${name}", which is not an input`);
            else if (used.has(name)) report(primary, 0, `${task.id}: NOT_EXEMPLIFIED lists "${name}", but an example now shows it; remove the exemption`);
        }

        for (const def of task.inputs.values()) {
            if (!def.options || OPEN_OPTION_LISTS.has(def.name)) continue;
            for (const option of def.options) {
                if (!mentioned.has(option)) report(primary, 0, `${task.id}: option "${option}" of "${def.name}" is never mentioned`);
            }
        }
        for (const name of EXEMPLIFY_EACH_OPTION.get(task.id) || []) {
            const def = task.inputs.get(name);
            if (!def || !def.options) continue;
            const values = new Set();
            for (const a of analyzed) {
                for (const section of a.sections.values()) {
                    for (const step of section.steps) {
                        if (step.id === task.id) values.add(step.has(name) ? step.value(name) : def.defaultValue);
                    }
                }
            }
            for (const option of def.options) {
                if (!values.has(option)) report(primary, 0, `${task.id}: no example sets ${name}: ${option}`);
            }
        }
        for (const output of task.outputs) {
            if (!new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(output)}($|[^A-Za-z0-9_])`).test(everything)) {
                report(primary, 0, `${task.id}: output variable "${output}" is never mentioned`);
            }
        }

        const heading = headings.find((h) => h.title.includes(task.id));
        if (!heading) {
            report(primary, 0, `${task.id}: no heading names this task`);
        } else if (!analyzed.some((a) => a.md.prose.some((p) => p.text.includes(`](#${heading.slug})`)))) {
            report(heading.doc.rel, heading.line, `${task.id}: no table-of-contents link points at this heading (#${heading.slug})`);
        }
        ctx.coverage.push({ id: task.id, shown, total: task.inputs.size, exempt: exempt.size, outputs: task.outputs.length });
    }
}

// ------------------------------------------------------------------ main ----

function parseArgs(argv) {
    let root = path.resolve(__dirname, '..');
    const docs = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') {
            if (!argv[i + 1]) throw new Error('--root needs a directory');
            root = path.resolve(argv[++i]);
        } else if (argv[i].startsWith('--')) {
            throw new Error(`unknown option ${argv[i]}`);
        } else {
            docs.push(argv[i]);
        }
    }
    return { root, docs: docs.length > 0 ? docs : DEFAULT_DOCS };
}

function main(argv) {
    const { root, docs } = parseArgs(argv);
    const problems = [];
    const report = (file, line, message) => problems.push({ file, line, message });
    const tasks = loadTasks(root, report);
    const ctx = {
        root,
        tasks,
        report,
        rel: '',
        used: new Map(),
        slugCache: new Map(),
        coverage: [],
        counts: { headings: 0, fences: 0, yaml: 0, steps: 0, external: 0, inputs: 0, references: 0, links: 0, inbound: 0 },
    };

    const analyzed = docs.map((rel) => analyzeDoc(ctx, rel)).filter(Boolean);
    if (analyzed.length > 0) {
        for (const a of analyzed) checkDeprecation(ctx, a);
        checkCompleteness(ctx, analyzed);
        const knownTokens = new Set();
        for (const task of tasks.values()) {
            task.inputs.forEach((def, name) => {
                knownTokens.add(name);
                (def.options || []).forEach((o) => knownTokens.add(o));
            });
            task.outputs.forEach((o) => knownTokens.add(o));
        }
        for (const a of analyzed) {
            a.stepNames.forEach((n) => knownTokens.add(n));
            a.yamlTokens.forEach((t) => knownTokens.add(t));
        }
        for (const a of analyzed) {
            ctx.rel = a.rel;
            checkProseDefaults(ctx, a.md, a.rel, a.sections);
            checkProseTokens(ctx, a.md, a.rel, knownTokens);
        }
        checkInboundAnchors(ctx, analyzed);

        // Floors: a document the gate cannot see anything in must not pass.
        const c = ctx.counts;
        if (tasks.size === 0) report(docs[0], 0, 'no tasks found under Tasks/, so nothing can be validated');
        if (c.yaml === 0) report(docs[0], 0, 'no ```yaml blocks found');
        if (c.steps === 0) report(docs[0], 0, 'no task steps found in any example');
    }

    const c = ctx.counts;
    console.log(`check-yaml-examples: ${docs.join(', ')}`);
    console.log(`  markdown:  ${c.headings} headings, ${c.fences} fenced blocks (${c.yaml} yaml)`);
    console.log(`  examples:  ${c.steps} task steps (${c.steps - c.external} of this repository, ${c.external} external), ${c.inputs} input values checked`);
    console.log(`  links:     ${c.links} relative links, ${c.references} step output references, ${c.inbound} anchors cited from other files`);
    for (const row of ctx.coverage) {
        console.log(`  coverage:  ${row.id.padEnd(36)} ${row.shown}/${row.total} inputs shown${row.exempt ? ` (+${row.exempt} exempt)` : ''}, ${row.outputs} output variable(s)`);
    }

    problems.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    for (const p of problems) console.error(`${p.file}${p.line > 0 ? `:${p.line}` : ''}: ${p.message}`);
    if (problems.length > 0) {
        console.error(`\ncheck-yaml-examples: FAILED, ${problems.length} problem(s).`);
        return 1;
    }
    console.log('check-yaml-examples: OK.');
    return 0;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (err) {
    console.error(`check-yaml-examples: ${err.message}`);
    process.exitCode = 2;
}
