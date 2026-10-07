#!/usr/bin/env node
'use strict';

// Self-test for check-yaml-examples.js and the YAML reader it is built on
// (lib/pipeline-yaml.js). The gate keeps docs/yaml-examples.md honest, so a bug
// in it fails open: an example that no longer matches its task would go on
// passing. This proves it fails, and fails for the right reason.
//
// Part 1 feeds the reader snippets with a known meaning and snippets it must
// refuse. Part 2 builds a scratch repository (three small tasks, one document,
// one linked document, one source file that cites a heading), proves the
// checker accepts a document that satisfies every rule, then breaks that
// document one way at a time and proves each break is reported. Cases that look
// like defects but are legitimate (a value that is a variable, the connection on
// `terraform test`, an input shown only in a second document) must stay green.
// The checker takes --root, so the scratch repository is exercised directly.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseYaml, toJS, YamlError } = require('./lib/pipeline-yaml.js');

const script = path.join(__dirname, 'check-yaml-examples.js');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-yaml-examples-selftest-'));
let failed = false;

function pass(name) {
    console.log(`OK: ${name}`);
}

function flunk(name, detail) {
    console.error(`FAIL: ${name}`);
    console.error(detail);
    failed = true;
}

// ------------------------------------------------------------ the reader ----

const PARSE_OK = [
    ['sequence of mappings', "- task: A@1\n  inputs:\n    x: 1\n    y: 'two'\n", [{ task: 'A@1', inputs: { x: 1, y: 'two' } }]],
    ['sequence indented from the root', '  - task: A@1\n    name: n\n', [{ task: 'A@1', name: 'n' }]],
    ['sequence at its parent key indent', 'steps:\n- a\n- b\nnext: c\n', { steps: ['a', 'b'], next: 'c' }],
    ['dash on its own line and nested dashes', '-\n  a: 1\n- - x\n  - y\n', [{ a: 1 }, ['x', 'y']]],
    [
        'literal and folded block scalars with chomping',
        'a: |\n  l1\n    l2\n  l3\nb: |-\n  x\nc: >-\n  one\n  two\n\n  three\nd: |+\n  keep\n\n\ne: end\n',
        { a: 'l1\n  l2\nl3\n', b: 'x', c: 'one two\nthree', d: 'keep\n\n\n', e: 'end' },
    ],
    [
        'quoted scalars and escapes',
        "a: 'it''s'\nb: \"tab\\there \\u0041\"\nc: \"say \\\"hi\\\"\"\n",
        { a: "it's", b: 'tab\there A', c: 'say "hi"' },
    ],
    ['quoted scalars are never typed', "a: 'true'\nb: \"1\"\n", { a: 'true', b: '1' }],
    [
        'comments',
        "# lead\na: 1 # trailing\n# between\nb: 'x # not a comment' # real\nc: https://example.com/#frag\n",
        { a: 1, b: 'x # not a comment', c: 'https://example.com/#frag' },
    ],
    ['flow collections', "a: [1, two, 'three']\nb: {x: 1, y: [a, b]}\nc: []\nd: {}\n", { a: [1, 'two', 'three'], b: { x: 1, y: ['a', 'b'] }, c: [], d: {} }],
    [
        'pipeline macros and expressions stay text',
        "a: $(foo.bar)\nb: ${{ ne(variables['x'], 'y') }}\nc: \"$(Agent.TempDirectory)/x\"\n",
        { a: '$(foo.bar)', b: "${{ ne(variables['x'], 'y') }}", c: '$(Agent.TempDirectory)/x' },
    ],
    ['typed plain scalars', 'a: true\nb: False\nc: null\nd: ~\ne:\nf: 1.5\ng: -3\nh: v1.2\n', { a: true, b: false, c: null, d: null, e: null, f: 1.5, g: -3, h: 'v1.2' }],
    ['template expression as a key', "${{ if eq(a, 'b') }}:\n  x: 1\n", { "${{ if eq(a, 'b') }}": { x: 1 } }],
    ['quoted keys', "'a b': 1\n\"c\": 2\n", { 'a b': 1, c: 2 }],
    ['empty document', '', null],
    ['comment-only document', '# nothing\n', null],
    ['Windows line endings', 'a: 1\r\nb:\r\n  - x\r\n', { a: 1, b: ['x'] }],
    ['colons and hashes inside plain scalars', 'url: https://example.com/a?b=c#d\npath: C:\\temp\\x\n', { url: 'https://example.com/a?b=c#d', path: 'C:\\temp\\x' }],
];

const PARSE_ERRORS = [
    ['tab indentation', 'a:\n\tb: 1\n', 'tab characters', 2],
    ['duplicate key', 'a: 1\nb: 2\na: 3\n', 'duplicate key "a"', 3],
    ['anchor', 'a: &x 1\n', 'anchors, aliases and tags', 1],
    ['alias', 'a: *x\n', 'anchors, aliases and tags', 1],
    ['tag', 'a: !!str 1\n', 'anchors, aliases and tags', 1],
    ['colon inside a plain scalar', 'a: b: c\n', 'cannot contain ": "', 1],
    ['second document', 'a: 1\n---\nb: 2\n', 'document markers', 2],
    ['directive', '%YAML 1.2\na: 1\n', 'directives are not supported', 1],
    ['multi-line plain scalar', 'a: foo\n  bar\n', 'bad indentation of a mapping entry', 2],
    ['unterminated quote', "a: 'x\n", 'unterminated quoted scalar', 1],
    ['unsupported escape', 'a: "\\q"\n', 'unsupported escape', 1],
    ['unterminated flow sequence', 'a: [1, 2\n', 'flow collection:', 1],
    ['plain scalar starting with @', 'a: @foo\n', 'cannot start a plain scalar', 1],
    ['text after a quoted scalar', "a: 'x' y\n", 'unexpected text after a quoted scalar', 1],
    ['bad block scalar header', 'a: |x\n  y\n', 'invalid block scalar header', 1],
];

for (const [name, text, expected] of PARSE_OK) {
    try {
        assert.deepStrictEqual(toJS(parseYaml(text)), expected);
        pass(`reader: ${name}`);
    } catch (err) {
        flunk(`reader: ${name}`, err.message);
    }
}

for (const [name, text, fragment, line] of PARSE_ERRORS) {
    try {
        parseYaml(text);
        flunk(`reader refuses: ${name}`, 'parsed without error');
    } catch (err) {
        if (err instanceof YamlError && err.message.includes(fragment) && err.line === line) {
            pass(`reader refuses: ${name}`);
        } else {
            flunk(`reader refuses: ${name}`, `expected "${fragment}" on line ${line}, got ${err.name}: ${err.message} (line ${err.line})`);
        }
    }
}

{
    const node = parseYaml('a: |\n  x\nb: y # note\n');
    const [a, b] = node.entries;
    if (a.value.literal === true && a.keyLine === 1 && a.value.line === 1 && b.keyLine === 3 && b.value.comment === 'note') {
        pass('reader: records literal block scalars, key lines and trailing comments');
    } else {
        flunk('reader: records literal block scalars, key lines and trailing comments', JSON.stringify(node));
    }
}

// ----------------------------------------------------------- the fixture ----

const lines = (...parts) => `${parts.join('\n')}\n`;

function taskJson(name, major, inputs, outputs, extra = {}) {
    return JSON.stringify({ name, version: { Major: String(major), Minor: '0', Patch: '0' }, inputs, outputVariables: outputs, ...extra }, null, 2);
}

const DEMO_INPUTS = [
    { name: 'mode', type: 'pickList', required: true, defaultValue: 'fast', options: { fast: 'Fast', slow: 'Slow' } },
    { name: 'target', type: 'string', required: true },
    { name: 'verbose', type: 'boolean', defaultValue: 'false' },
    { name: 'level', type: 'string', defaultValue: '3', visibleRule: 'mode = slow' },
    { name: 'token', type: 'password' },
    { name: 'note', type: 'string', defaultValue: 'none' },
];

const OLD_INPUTS = [{ name: 'name', type: 'string', required: true }];

const TERRAFORM_INPUTS = [
    { name: 'provider', type: 'pickList', required: true, defaultValue: 'azurerm', options: { azurerm: 'Azure', aws: 'AWS' } },
    { name: 'command', type: 'pickList', required: true, defaultValue: 'init', options: { init: 'init', plan: 'plan', apply: 'apply', show: 'show', test: 'test' } },
    { name: 'commandOptions', type: 'string' },
    { name: 'varFile', type: 'multiLine', visibleRule: 'command = plan || command = apply' },
    { name: 'refreshOnly', type: 'boolean', defaultValue: 'false', visibleRule: 'command = plan || command = apply' },
    { name: 'testFilter', type: 'string', visibleRule: 'command = test' },
    { name: 'outputTo', type: 'pickList', required: true, defaultValue: 'console', options: { file: 'file', console: 'console' }, visibleRule: 'command = show' },
    { name: 'filename', type: 'string', required: true, visibleRule: 'command = show && outputTo = file' },
    { name: 'cleanupShowFileIfSensitive', type: 'boolean', defaultValue: 'true', visibleRule: 'command = show' },
    { name: 'publishApplyResults', type: 'string', visibleRule: 'command = apply' },
    { name: 'includeDiagnostics', type: 'boolean', defaultValue: 'false', visibleRule: 'command = apply' },
    { name: 'includeDiagnosticDetail', type: 'boolean', defaultValue: 'false', visibleRule: 'command = apply' },
    {
        name: 'environmentServiceNameAzureRM',
        type: 'connectedService:AzureRM',
        required: true,
        visibleRule: 'provider = azurerm && command != init && command != test',
    },
    { name: 'backendType', type: 'pickList', defaultValue: 'azurerm', options: { azurerm: 'Azure', local: 'Local' }, visibleRule: 'command = init' },
    { name: 'backendServiceArm', type: 'connectedService:AzureRM', required: true, groupName: 'backendAzureRm' },
    { name: 'backendAzureRmKey', type: 'string', required: true, groupName: 'backendAzureRm' },
];

const DOC = 'docs/yaml-examples.md';
const DEMO = 'Tasks/Demo/DemoTaskV1/task.json';
const OLD = 'Tasks/Demo/OldTaskV1/task.json';
const TERRAFORM = 'Tasks/Terraform/PipelineTerraformTaskV5/task.json';

const GOOD_DOC = lines(
    '# Examples',
    '',
    '- [DemoTask@1](#demotask1)',
    '- [OldTask@1](#oldtask1) (deprecated)',
    '- [PipelineTerraformTask@5](#pipelineterraformtask5)',
    '',
    'See the [guide](guide.md#setup).',
    '',
    '## DemoTask@1',
    '',
    '`mode` is `fast` or `slow`. The task sets `resultPath`. `level` (default `3`) applies in slow mode.',
    '',
    '```yaml',
    '- task: DemoTask@1',
    '  name: demo',
    '  inputs:',
    "    mode: 'slow'                 # fast | slow",
    "    target: 'x'",
    '    verbose: true                # default false',
    "    level: '5'",
    "    token: '$(DEMO_TOKEN)'",
    "    note: 'none'                 # default",
    '- script: echo $(demo.resultPath)',
    '```',
    '',
    '## OldTask@1',
    '',
    'OldTask@1 is deprecated; use DemoTask@1.',
    '',
    '```yaml',
    '- task: OldTask@1',
    '  inputs:',
    "    name: 'x'",
    '```',
    '',
    '## PipelineTerraformTask@5',
    '',
    'Providers: `azurerm`, `aws`. Backends: `azurerm`, `local`. Commands: `init`, `plan`, `apply`, `show`, `test`.',
    'Output goes to `console` or `file`. Outputs: `showFilePath`, `changesPresent`.',
    '',
    '```yaml',
    '- task: PipelineTerraformTask@5',
    '  inputs:',
    "    command: 'init'",
    "    backendType: 'azurerm'",
    "    backendServiceArm: 'sc'",
    "    backendAzureRmKey: 'k'",
    '- task: PipelineTerraformTask@5',
    '  inputs:',
    "    command: 'init'",
    "    backendType: 'local'",
    '- task: PipelineTerraformTask@5',
    '  name: tfplan',
    '  inputs:',
    "    command: 'plan'",
    "    provider: 'aws'",
    '    varFile: |',
    '      a.tfvars',
    '    refreshOnly: true',
    "    commandOptions: '-out=tfplan'",
    '- task: PipelineTerraformTask@5',
    '  name: tfapply',
    '  inputs:',
    "    command: 'apply'",
    "    environmentServiceNameAzureRM: 'sc'",
    "    commandOptions: 'tfplan'",
    "    publishApplyResults: 'summary'",
    '    includeDiagnostics: true',
    '    includeDiagnosticDetail: true',
    '- task: PipelineTerraformTask@5',
    '  name: tfshow',
    '  inputs:',
    "    command: 'show'",
    "    environmentServiceNameAzureRM: 'sc'",
    "    outputTo: 'file'",
    "    filename: '$(Agent.TempDirectory)/plan.json'",
    '    cleanupShowFileIfSensitive: false',
    "    commandOptions: 'tfplan'",
    '- script: cat $(tfshow.showFilePath)',
    '- task: PipelineTerraformTask@5',
    '  inputs:',
    "    command: 'test'",
    "    testFilter: 'tests/unit.tftest.hcl'",
    "    environmentServiceNameAzureRM: 'sc'",
    '```',
);

function baseFiles() {
    return {
        [DEMO]: taskJson('DemoTask', 1, DEMO_INPUTS, [{ name: 'resultPath' }]),
        [OLD]: taskJson('OldTask', 1, OLD_INPUTS, undefined, { deprecated: true }),
        [TERRAFORM]: taskJson('PipelineTerraformTask', 5, TERRAFORM_INPUTS, [{ name: 'showFilePath' }, { name: 'changesPresent' }]),
        [DOC]: GOOD_DOC,
        'docs/guide.md': lines('# Guide', '', '## Setup'),
        'src/messages.ts': lines('// See docs/yaml-examples.md#demotask1'),
    };
}

// Replaces the first occurrence of `from`, and fails the self-test itself when
// the fixture no longer contains it, so a stale edit cannot pass vacuously.
function edit(files, file, from, to) {
    const text = files[file];
    if (typeof text !== 'string' || !text.includes(from)) {
        throw new Error(`self-test fixture is stale: ${file} does not contain ${JSON.stringify(from)}`);
    }
    files[file] = text.replace(from, () => to);
}

function editJson(files, file, change) {
    const json = JSON.parse(files[file]);
    change(json);
    files[file] = JSON.stringify(json, null, 2);
}

function run(files, args = []) {
    const dir = fs.mkdtempSync(path.join(scratchDir, 'case-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    const res = spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8' });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function accepts(name, change, args = []) {
    try {
        const files = baseFiles();
        change(files);
        const { status, out } = run(files, args);
        if (status === 0 && out.includes('check-yaml-examples: OK.')) pass(name);
        else flunk(name, `expected exit 0, got ${status}\n${out}`);
    } catch (err) {
        flunk(name, err.stack);
    }
}

function rejects(name, change, needles, { status: wanted = 1, args = [] } = {}) {
    try {
        const files = baseFiles();
        change(files);
        const { status, out } = run(files, args);
        const missing = needles.filter((n) => !out.includes(n));
        if (status === wanted && missing.length === 0) pass(name);
        else flunk(name, `expected exit ${wanted} and ${JSON.stringify(needles)}, got exit ${status}; missing ${JSON.stringify(missing)}\n${out}`);
    } catch (err) {
        flunk(name, err.stack);
    }
}

// ---------------------------------------------------------- the checker ----

try {
    accepts('accepts a document that satisfies every rule', () => {});

    // Examples against task.json.
    rejects('rejects a task that does not exist', (f) => edit(f, DOC, '- task: DemoTask@1', '- task: DemoTsk@1'), [
        'task "DemoTsk@1" is neither a task of this repository nor listed in EXTERNAL_TASKS',
    ]);
    rejects('rejects a major version that does not exist', (f) => edit(f, DOC, '- task: DemoTask@1', '- task: DemoTask@2'), [
        'task "DemoTask@2" does not exist; this repository ships DemoTask@1',
    ]);
    accepts('accepts an external task from the allowlist', (f) =>
        edit(f, DOC, '- script: echo $(demo.resultPath)', "- script: echo $(demo.resultPath)\n- task: PublishTestResults@2\n  inputs:\n    testResultsFiles: '**/*.xml'"));
    rejects('rejects an input the task does not declare', (f) => edit(f, DOC, "    target: 'x'\n", "    target: 'x'\n    bogus: 1\n"), [
        '"bogus" is not an input of DemoTask@1',
    ]);
    rejects('rejects a value that is not one of the options', (f) => edit(f, DOC, "mode: 'slow'", "mode: 'turbo'"), [
        '"turbo" is not an option of "mode" (options: fast, slow)',
    ]);
    rejects('rejects a boolean input that is not true or false', (f) => edit(f, DOC, 'verbose: true  ', 'verbose: yes   '), [
        '"verbose" is a boolean input; use true or false, not "yes"',
    ]);
    rejects('rejects a missing required input', (f) => edit(f, DOC, "    target: 'x'\n", ''), ['required input "target" of DemoTask@1 is missing']);
    rejects('rejects an input its own visibleRule hides', (f) => edit(f, DOC, "mode: 'slow'", "mode: 'fast'"), ['"level" has no effect here, its visibleRule is false']);
    rejects('rejects a literal secret', (f) => edit(f, DOC, "token: '$(DEMO_TOKEN)'", "token: 'hunter2'"), ['"token" is a secret input']);
    rejects('rejects an input whose value is not a scalar', (f) => edit(f, DOC, "target: 'x'", 'target: [a, b]'), ['the value of "target" must be a scalar']);
    rejects('rejects inputs that are not a mapping', (f) => edit(f, DOC, '  inputs:\n    mode', '  inputs: oops\n  other:\n    mode'), [
        'inputs must be a mapping of input name to value',
    ]);
    accepts('does not judge a pick-list value that is a variable', (f) => edit(f, DOC, "mode: 'slow'", "mode: '$(m)'"));
    accepts('does not judge a pick-list value that is a template expression', (f) => edit(f, DOC, "mode: 'slow'", 'mode: ${{ parameters.mode }}'));
    accepts('does not require the connection on terraform test, which the rule hides', (f) =>
        edit(f, DOC, "    testFilter: 'tests/unit.tftest.hcl'\n    environmentServiceNameAzureRM: 'sc'\n", "    testFilter: 'tests/unit.tftest.hcl'\n"));
    rejects('rejects the connection on a command whose rule hides it', (f) => edit(f, DOC, "    backendType: 'local'\n", "    backendType: 'local'\n    environmentServiceNameAzureRM: 'sc'\n"), [
        '"environmentServiceNameAzureRM" has no effect here',
    ]);
    rejects('requires a backend group input only for the backend that is selected', (f) => edit(f, DOC, "    backendAzureRmKey: 'k'\n", ''), [
        'required input "backendAzureRmKey" of PipelineTerraformTask@5 is missing',
    ]);

    // Behaviour the schema cannot express.
    rejects('rejects planning inputs on an apply of a saved plan', (f) =>
        edit(f, DOC, "    commandOptions: 'tfplan'\n    publishApplyResults", "    commandOptions: 'tfplan'\n    varFile: |\n      a.tfvars\n    publishApplyResults"), [
        'applying the saved plan "tfplan" cannot take varFile',
    ]);
    rejects('rejects -var in commandOptions on an apply of a saved plan', (f) => edit(f, DOC, "commandOptions: 'tfplan'\n    publishApplyResults", "commandOptions: 'tfplan -var=a=b'\n    publishApplyResults"), [
        'cannot take -var in commandOptions',
    ]);
    rejects('rejects a show file that is read while cleanup deletes it', (f) => edit(f, DOC, '    cleanupShowFileIfSensitive: false\n', ''), [
        '"tfshow.showFilePath" is read by a later step',
        'cleanupShowFileIfSensitive: false',
    ]);
    rejects('rejects a test filter that is not a test file', (f) => edit(f, DOC, "testFilter: 'tests/unit.tftest.hcl'", "testFilter: 'tests/unit'"), [
        'testFilter is passed as -filter=<test file>',
    ]);
    rejects('rejects diagnostic detail without the diagnostics switch', (f) => edit(f, DOC, '    includeDiagnostics: true\n', '    includeDiagnostics: false\n'), [
        'includeDiagnosticDetail has no effect unless includeDiagnostics is true',
    ]);
    rejects('rejects diagnostics options without publishApplyResults', (f) => edit(f, DOC, "    publishApplyResults: 'summary'\n", ''), [
        'the diagnostics options are only read when publishApplyResults is set',
    ]);

    // Step output references.
    rejects('rejects a reference to a step that does not exist', (f) => edit(f, DOC, '$(demo.resultPath)', '$(nope.resultPath)'), [
        '"nope.resultPath" refers to a step named "nope"',
    ]);
    rejects('rejects a reference to an output the task does not set', (f) => edit(f, DOC, '$(demo.resultPath)', '$(demo.missing)'), [
        'DemoTask@1 (step "demo") does not set an output variable "missing" (it sets: resultPath)',
    ]);
    rejects('rejects a reference to a step of another section', (f) => {
        edit(f, DOC, '- script: echo $(demo.resultPath)', '- script: echo ok');
        edit(f, DOC, "    name: 'x'\n```", "    name: 'x'\n- script: echo $(demo.resultPath)\n```");
    }, ['"demo.resultPath" refers to a step named "demo" that is not defined earlier in this section']);
    rejects('rejects a reference that is not preceded by its step', (f) => {
        edit(f, DOC, '- task: DemoTask@1\n  name: demo\n', '- script: echo $(demo.resultPath)\n- task: DemoTask@1\n  name: demo\n');
        edit(f, DOC, '- script: echo $(demo.resultPath)\n```', '```');
    }, ['"demo.resultPath" refers to a step named "demo"']);
    rejects('rejects a step name used twice in one example', (f) =>
        edit(f, DOC, "    note: 'none'                 # default\n", "    note: 'none'                 # default\n- task: DemoTask@1\n  name: demo\n  inputs:\n    target: 'y'\n"), [
        'step name "demo" is used twice in this example',
    ]);
    accepts('does not treat a predefined variable as a step output', (f) => edit(f, DOC, '- script: echo $(demo.resultPath)', '- script: echo $(demo.resultPath) $(Build.BuildId) $(Agent.TempDirectory)'));

    // YAML.
    rejects('reports a YAML syntax error on its line in the document', (f) => edit(f, DOC, '    verbose: true ', '\tverbose: true '), [
        `yaml-examples.md:${GOOD_DOC.split('\n').findIndex((l) => l.startsWith('    verbose:')) + 1}: YAML: tab characters are not allowed for indentation`,
    ]);
    rejects('rejects a construct the reader does not support', (f) => edit(f, DOC, '  name: demo\n', '  name: &anchor demo\n'), ['YAML: anchors, aliases and tags are not supported']);
    rejects('rejects a fenced block that is never closed', (f) => {
        f[DOC] += '\n```yaml\n- task: DemoTask@1\n';
    }, ['fenced code block is never closed']);

    // Links and anchors.
    rejects('rejects a link to a file that does not exist', (f) => edit(f, DOC, '(guide.md#setup)', '(missing.md)'), ['link target "missing.md" does not exist']);
    rejects('rejects a link to a heading another document lacks', (f) => edit(f, DOC, '(guide.md#setup)', '(guide.md#nope)'), [
        'link to "guide.md#nope": that file has no such heading',
    ]);
    rejects('rejects a link to a heading this document lacks', (f) => edit(f, DOC, 'See the [guide]', 'See [x](#nope) and the [guide]'), [
        'link to #nope has no matching heading in this document',
    ]);
    rejects('rejects a source file citing a heading that does not exist', (f) => edit(f, 'src/messages.ts', 'yaml-examples.md#demotask1', 'yaml-examples.md#gone'), [
        'src/messages.ts:1: cites yaml-examples.md#gone, which is not a heading anchor in that document',
    ]);
    accepts('ignores external links and links inside code spans', (f) => edit(f, DOC, 'See the [guide]', 'See [site](https://example.com/x), `[no](missing.md)` and the [guide]'));

    // Prose.
    rejects('rejects a deprecated task whose section does not say so', (f) => edit(f, DOC, 'OldTask@1 is deprecated; use DemoTask@1.', 'Use OldTask@1 for legacy pipelines.'), [
        'this section uses deprecated task(s) OldTask@1 but its text never says they are deprecated',
    ]);
    rejects('rejects a deprecated task whose table-of-contents entry does not say so', (f) => edit(f, DOC, ' (deprecated)', ''), [
        'the table-of-contents entry for deprecated task OldTask@1 does not say it is deprecated',
    ]);
    rejects('rejects a comment that states a wrong default', (f) => edit(f, DOC, '# default false', '# default true'), [
        'the comment on "verbose" says the default is "true", but task.json says "false"',
    ]);
    rejects('rejects a comment that calls a non-default value the default', (f) => edit(f, DOC, "note: 'none'                 # default", "note: 'other'                # default"), [
        'the comment on "note" says the value is the default, but the default is "none"',
    ]);
    rejects('rejects a comment whose option list differs from task.json', (f) => edit(f, DOC, '# fast | slow', '# fast | slow | turbo'), [
        'the option list in the comment on "mode" differs from task.json (missing: none; unknown: turbo)',
    ]);
    rejects('rejects prose that states a wrong default', (f) => edit(f, DOC, '`level` (default `3`)', '`level` (default `4`)'), [
        'the text says the default of "level" is "4", but task.json says "3"',
    ]);
    rejects('rejects a wrong default in a claim split over two lines', (f) => edit(f, DOC, '`level` (default `3`)', '`level`\n(default `4`)'), [
        'the text says the default of "level" is "4"',
    ]);
    rejects('rejects a wrong default in "defaults to" prose', (f) => edit(f, DOC, 'applies in slow mode.', 'applies in slow mode; `note` defaults to `other`.'), [
        'the text says the default of "note" is "other", but task.json says "none"',
    ]);
    rejects('rejects prose naming an input that does not exist', (f) => edit(f, DOC, 'applies in slow mode.', 'applies in slow mode, see `levelName`.'), [
        '"levelName" looks like an input or output name but matches none',
    ]);
    rejects('rejects prose naming a task that does not exist', (f) => edit(f, DOC, 'applies in slow mode.', 'applies in slow mode, like `GhostTask@1`.'), [
        '"GhostTask@1" is not a task of this repository',
    ]);

    // Completeness.
    rejects('rejects an input no example shows', (f) => edit(f, DOC, "    note: 'none'                 # default\n", ''), [
        'DemoTask@1: input "note" is never shown in a YAML example',
    ]);
    accepts('counts an input shown in a second document', (f) => {
        edit(f, DOC, "    note: 'none'                 # default\n", '');
        f['docs/more.md'] = lines('# More', '', '```yaml', '- task: DemoTask@1', '  inputs:', "    target: 'y'", "    note: 'none'", '```');
    }, [DOC, 'docs/more.md']);
    rejects('rejects a pick-list option that is never mentioned', (f) => editJson(f, DEMO, (j) => {
        j.inputs[0].options.turbo = 'Turbo';
    }), ['DemoTask@1: option "turbo" of "mode" is never mentioned']);
    rejects('rejects an output variable that is never mentioned', (f) => editJson(f, DEMO, (j) => {
        j.outputVariables.push({ name: 'extraOut' });
    }), ['DemoTask@1: output variable "extraOut" is never mentioned']);
    rejects('rejects a task with no heading', (f) => edit(f, DOC, '## OldTask@1', '## Legacy'), ['OldTask@1: no heading names this task']);
    rejects('rejects a task heading with no table-of-contents link', (f) => edit(f, DOC, '- [OldTask@1](#oldtask1) (deprecated)\n', ''), [
        'OldTask@1: no table-of-contents link points at this heading (#oldtask1)',
    ]);
    rejects('rejects an option of a dimension input that no example sets', (f) => edit(f, DOC, "backendType: 'local'", "backendType: 'azurerm'"), [
        'PipelineTerraformTask@5: no example sets backendType: local',
    ]);
    accepts('counts an omitted dimension input as its default', (f) => edit(f, DOC, "    environmentServiceNameAzureRM: 'sc'\n    commandOptions: 'tfplan'\n    publishApplyResults", "    environmentServiceNameAzureRM: 'sc'\n    provider: 'azurerm'\n    commandOptions: 'tfplan'\n    publishApplyResults"));

    // Floors and failure modes of the gate itself.
    rejects('rejects a document with no YAML examples', (f) => {
        f[DOC] = lines('# Examples', '', '## DemoTask@1', '', 'Nothing here.');
    }, ['no ```yaml blocks found']);
    rejects('rejects a document that does not exist', () => {}, ['documentation file not found'], { args: ['docs/nope.md'] });
    rejects('rejects a task.json that is not JSON', (f) => {
        f[DEMO] = '{ not json';
    }, ['not valid JSON']);
    rejects('refuses a visibleRule it cannot read instead of skipping it', (f) => editJson(f, DEMO, (j) => {
        j.inputs[3].visibleRule = 'contains(mode, slow)';
    }), ['unsupported visibleRule clause', 'extend parseRule'], { status: 2 });
    rejects('rejects an unknown command-line option', () => {}, ['unknown option --nope'], { status: 2, args: ['--nope'] });
    rejects('rejects a repository with no tasks', (f) => {
        for (const key of [DEMO, OLD, TERRAFORM]) delete f[key];
    }, ['no tasks found under Tasks/']);
} finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (failed) {
    console.error('\ncheck-yaml-examples.js self-test: FAILED.');
    process.exit(1);
}
console.log('check-yaml-examples.js self-test: all cases passed.');
