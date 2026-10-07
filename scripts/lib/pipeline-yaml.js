'use strict';

// A strict reader for the YAML subset that Azure Pipelines examples are written
// in. It exists so scripts/check-yaml-examples.js can validate documentation
// snippets without a YAML library: the check-versions job that runs this
// repository's gates does no `npm ci`, and these scripts are dependency-free by
// convention.
//
// Read: block mappings and sequences (including a sequence written at its
// parent key's indent, and one indented from the root), plain, 'single' and
// "double" quoted scalars, `|` and `>` block scalars with chomping and
// indentation indicators, single-line flow collections, and comments.
//
// Refused, rather than guessed at: anchors, aliases, tags, multiple documents,
// tab indentation, duplicate keys, multi-line plain or quoted scalars, and `: `
// inside a plain scalar. A validator that quietly mis-reads an example would
// pass a broken one, so anything this reader does not understand is a
// YamlError carrying the 1-based line it was found on.
//
// Nodes (every one carries `line`, relative to the text given):
//   { kind: 'scalar', text, value, quoted, comment }  text is the string form
//       ('' for null); value is typed (string | number | boolean | null);
//       quoted is true for quoted and block scalars, which are never typed.
//       literal is true for a `|` block scalar, whose text starts on the line
//       after `line` (the header line).
//   { kind: 'seq', items }
//   { kind: 'map', entries: [{ key, keyLine, value }] }

class YamlError extends Error {
    constructor(message, line) {
        super(message);
        this.name = 'YamlError';
        this.line = line;
    }
}

const ESCAPES = new Map([
    ['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['n', '\n'], ['v', '\v'], ['f', '\f'], ['r', '\r'],
    ['e', '\x1b'], [' ', ' '], ['"', '"'], ['/', '/'], ['\\', '\\'], ['N', '\x85'], ['_', '\xa0'],
]);

function resolvePlain(body) {
    if (body === '' || body === '~' || /^(null|Null|NULL)$/.test(body)) return null;
    if (/^(true|True|TRUE)$/.test(body)) return true;
    if (/^(false|False|FALSE)$/.test(body)) return false;
    if (/^[-+]?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(body)) return Number(body);
    return body;
}

function plainNode(body, line, comment) {
    const value = resolvePlain(body);
    return { kind: 'scalar', text: value === null ? '' : body, value, line, quoted: false, comment };
}

function stringNode(text, line, comment = '') {
    return { kind: 'scalar', text, value: text, line, quoted: true, comment };
}

function nullNode(line, comment = '') {
    return { kind: 'scalar', text: '', value: null, line, quoted: false, comment };
}

// Reads one quoted scalar from the start of `text`; returns its value and the
// index just past the closing quote.
function readQuoted(text, line) {
    const quote = text[0];
    let out = '';
    for (let i = 1; i < text.length; i++) {
        const c = text[i];
        if (quote === "'") {
            if (c !== "'") {
                out += c;
            } else if (text[i + 1] === "'") {
                out += "'";
                i += 1;
            } else {
                return { value: out, end: i + 1 };
            }
            continue;
        }
        if (c === '"') return { value: out, end: i + 1 };
        if (c !== '\\') {
            out += c;
            continue;
        }
        i += 1;
        const n = text[i];
        if (n === 'x' || n === 'u' || n === 'U') {
            const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
            const hex = text.slice(i + 1, i + 1 + len);
            let char;
            try {
                if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new Error('bad hex');
                char = String.fromCodePoint(parseInt(hex, 16));
            } catch {
                throw new YamlError(`invalid \\${n} escape in a double-quoted scalar`, line);
            }
            out += char;
            i += len;
        } else if (n !== undefined && ESCAPES.has(n)) {
            out += ESCAPES.get(n);
        } else {
            throw new YamlError(`unsupported escape "\\${n === undefined ? '' : n}" in a double-quoted scalar`, line);
        }
    }
    throw new YamlError('unterminated quoted scalar (multi-line quoted scalars are not supported)', line);
}

// A comment starts at a `#` that begins the text or follows whitespace.
function splitComment(text) {
    const m = /(^|\s)#/.exec(text);
    if (!m) return { body: text.trim(), comment: '' };
    return { body: text.slice(0, m.index).trim(), comment: text.slice(m.index + m[1].length + 1).trim() };
}

function plainScalar(text, line) {
    const { body, comment } = splitComment(text);
    if (/^[@`%]/.test(body)) {
        throw new YamlError(`"${body[0]}" cannot start a plain scalar; quote the value`, line);
    }
    if (/:(\s|$)/.test(body)) {
        throw new YamlError('a plain scalar cannot contain ": " (mapping values are not allowed here); quote the value', line);
    }
    return plainNode(body, line, comment);
}

function isSeqEntry(text) {
    return text === '-' || text.startsWith('- ');
}

// Splits `key: rest` at the first colon that ends a key. Colons inside `$(...)`
// and `${{ ... }}` belong to the text, not to a key.
function splitKey(text, line) {
    const c = text[0];
    if (c === "'" || c === '"') {
        const q = readQuoted(text, line);
        const after = text.slice(q.end);
        const m = /^ *:( |$)/.exec(after);
        return m ? { key: q.value, rest: after.slice(m[0].length).trim() } : null;
    }
    if ('[{|>&*!#'.includes(c)) return null;
    let macro = 0;
    let expr = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '$' && text[i + 1] === '(') {
            macro += 1;
            i += 1;
        } else if (ch === '$' && text[i + 1] === '{' && text[i + 2] === '{') {
            expr += 1;
            i += 2;
        } else if (ch === ')' && macro > 0) {
            macro -= 1;
        } else if (ch === '}' && text[i + 1] === '}' && expr > 0) {
            expr -= 1;
            i += 1;
        } else if (ch === '#' && text[i - 1] === ' ') {
            return null;
        } else if (ch === ':' && macro === 0 && expr === 0 && (i + 1 === text.length || text[i + 1] === ' ')) {
            const key = text.slice(0, i).trim();
            return key === '' ? null : { key, rest: text.slice(i + 1).trim() };
        }
    }
    return null;
}

function fold(lines) {
    let out = '';
    let blanks = 0;
    let prevMore = false;
    let first = true;
    for (const l of lines) {
        if (l.blank) {
            blanks += 1;
            continue;
        }
        const more = /^\s/.test(l.text);
        if (first) out = l.text;
        else if (!more && !prevMore) out += (blanks ? '\n'.repeat(blanks) : ' ') + l.text;
        else out += '\n'.repeat(blanks + 1) + l.text;
        first = false;
        blanks = 0;
        prevMore = more;
    }
    return out;
}

// A flow collection that fits on one line: `[a, b]`, `{k: v}`, nested.
function parseFlow(text, line) {
    let p = 0;
    const fail = (msg) => {
        throw new YamlError(`flow collection: ${msg}`, line);
    };
    const ws = () => {
        while (text[p] === ' ') p += 1;
    };

    function token(inKey) {
        if (text[p] === "'" || text[p] === '"') {
            const q = readQuoted(text.slice(p), line);
            p += q.end;
            return stringNode(q.value, line);
        }
        const start = p;
        while (p < text.length) {
            const ch = text[p];
            if (ch === ',' || ch === ']' || ch === '}') break;
            if (inKey && ch === ':' && (text[p + 1] === undefined || ' ,]}'.includes(text[p + 1]))) break;
            if (ch === '#' && text[p - 1] === ' ') break;
            p += 1;
        }
        const body = text.slice(start, p).trim();
        return body === '' ? nullNode(line) : plainNode(body, line, '');
    }

    function value(inKey) {
        ws();
        if (text[p] === '[') return sequence();
        if (text[p] === '{') return mapping();
        return token(inKey);
    }

    function sequence() {
        p += 1;
        const items = [];
        ws();
        if (text[p] === ']') {
            p += 1;
            return { kind: 'seq', items, line };
        }
        for (;;) {
            items.push(value(false));
            ws();
            if (text[p] === ',') {
                p += 1;
                ws();
                if (text[p] === ']') {
                    p += 1;
                    break;
                }
            } else if (text[p] === ']') {
                p += 1;
                break;
            } else {
                fail('expected "," or "]" (multi-line flow collections are not supported)');
            }
        }
        return { kind: 'seq', items, line };
    }

    function mapping() {
        p += 1;
        const entries = [];
        ws();
        if (text[p] === '}') {
            p += 1;
            return { kind: 'map', entries, line };
        }
        for (;;) {
            const key = value(true);
            ws();
            let val = nullNode(line);
            if (text[p] === ':') {
                p += 1;
                ws();
                if (text[p] !== ',' && text[p] !== '}') val = value(false);
            }
            entries.push({ key: key.text, keyLine: line, value: val });
            ws();
            if (text[p] === ',') {
                p += 1;
                ws();
                if (text[p] === '}') {
                    p += 1;
                    break;
                }
            } else if (text[p] === '}') {
                p += 1;
                break;
            } else {
                fail('expected "," or "}" (multi-line flow collections are not supported)');
            }
        }
        return { kind: 'map', entries, line };
    }

    const node = value(false);
    ws();
    const tail = text.slice(p).trim();
    if (tail && tail[0] !== '#') fail('unexpected text after the closing bracket');
    return node;
}

class Parser {
    constructor(text) {
        this.lines = String(text)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((raw, idx) => {
                const trimmed = raw.replace(/\s+$/, '');
                const body = trimmed.replace(/^ +/, '');
                return { no: idx + 1, indent: trimmed.length - body.length, text: body };
            });
        this.i = 0;
    }

    // The next line that is neither blank nor a comment; not consumed.
    peek() {
        while (this.i < this.lines.length) {
            const ln = this.lines[this.i];
            if (ln.text === '' || ln.text[0] === '#') {
                this.i += 1;
                continue;
            }
            if (ln.text[0] === '\t') throw new YamlError('tab characters are not allowed for indentation', ln.no);
            if (ln.indent === 0 && (ln.text === '---' || ln.text === '...' || ln.text.startsWith('--- '))) {
                throw new YamlError('document markers (multiple documents) are not supported', ln.no);
            }
            if (ln.indent === 0 && ln.text[0] === '%') throw new YamlError('directives are not supported', ln.no);
            return ln;
        }
        return null;
    }

    parse() {
        const first = this.peek();
        if (!first) return nullNode(1);
        const node = this.parseBlock();
        const extra = this.peek();
        if (extra) throw new YamlError('unexpected content (check the indentation)', extra.no);
        return node;
    }

    parseBlock() {
        const line = this.peek();
        if (isSeqEntry(line.text)) return this.parseSeq(line.indent);
        if (splitKey(line.text, line.no)) return this.parseMap(line.indent);
        this.i += 1;
        const parent = line.scalarParent === undefined ? line.indent - 1 : line.scalarParent;
        return this.parseInline(line.text, line.no, parent);
    }

    parseSeq(indent) {
        const items = [];
        const start = this.peek().no;
        for (;;) {
            const line = this.peek();
            if (!line || line.indent < indent) break;
            if (line.indent > indent) throw new YamlError('bad indentation of a sequence entry', line.no);
            if (!isSeqEntry(line.text)) break;
            const after = line.text === '-' ? '' : line.text.slice(1);
            const rest = after.trimStart();
            if (rest === '' || rest[0] === '#') {
                this.i += 1;
                const next = this.peek();
                items.push(next && next.indent > indent ? this.parseBlock() : nullNode(line.no));
                continue;
            }
            // Re-seat the entry's content as a line at its own column, so a
            // mapping that starts after the dash continues on the lines below.
            this.lines[this.i] = { no: line.no, indent: indent + 1 + (after.length - rest.length), text: rest, scalarParent: indent };
            items.push(this.parseBlock());
        }
        return { kind: 'seq', items, line: start };
    }

    parseMap(indent) {
        const entries = [];
        const seen = new Set();
        const start = this.peek().no;
        for (;;) {
            const line = this.peek();
            if (!line || line.indent < indent) break;
            if (line.indent > indent) {
                throw new YamlError('bad indentation of a mapping entry (multi-line plain scalars are not supported; quote the value or use a block scalar)', line.no);
            }
            if (isSeqEntry(line.text)) break;
            const split = splitKey(line.text, line.no);
            if (!split) throw new YamlError('expected a "key: value" pair', line.no);
            if (seen.has(split.key)) throw new YamlError(`duplicate key "${split.key}"`, line.no);
            seen.add(split.key);
            this.i += 1;
            entries.push({ key: split.key, keyLine: line.no, value: this.parseValue(split.rest, line, indent) });
        }
        return { kind: 'map', entries, line: start };
    }

    parseValue(rest, line, parentIndent) {
        if (rest === '' || rest[0] === '#') {
            const next = this.peek();
            if (next && next.indent > parentIndent) return this.parseBlock();
            if (next && next.indent === parentIndent && isSeqEntry(next.text)) return this.parseSeq(parentIndent);
            return nullNode(line.no, rest.slice(1).trim());
        }
        return this.parseInline(rest, line.no, parentIndent);
    }

    parseInline(text, no, parentIndent) {
        const c = text[0];
        if (c === '|' || c === '>') return this.parseBlockScalar(text, no, parentIndent);
        if (c === '[' || c === '{') return parseFlow(text, no);
        if (c === '&' || c === '*' || c === '!') throw new YamlError('anchors, aliases and tags are not supported', no);
        if (c === "'" || c === '"') {
            const q = readQuoted(text, no);
            const tail = text.slice(q.end).trim();
            if (tail && tail[0] !== '#') throw new YamlError('unexpected text after a quoted scalar', no);
            return stringNode(q.value, no, tail.slice(1).trim());
        }
        return plainScalar(text, no);
    }

    parseBlockScalar(header, no, parentIndent) {
        const m = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(header);
        if (!m || (m[2] && m[4])) throw new YamlError(`invalid block scalar header "${header}"`, no);
        const chomp = m[2] || m[4];
        let blockIndent = m[3] ? parentIndent + Number(m[3]) : -1;
        const body = [];
        while (this.i < this.lines.length) {
            const ln = this.lines[this.i];
            if (ln.text === '') {
                body.push({ blank: true, text: '' });
                this.i += 1;
                continue;
            }
            if (ln.indent <= parentIndent) break;
            if (blockIndent < 0) blockIndent = ln.indent;
            if (ln.indent < blockIndent) throw new YamlError('bad indentation inside a block scalar', ln.no);
            body.push({ blank: false, text: ' '.repeat(ln.indent - blockIndent) + ln.text });
            this.i += 1;
        }
        let end = body.length;
        while (end > 0 && body[end - 1].blank) end -= 1;
        const trailing = body.length - end;
        const content = body.slice(0, end);
        let text = m[1] === '>' ? fold(content) : content.map((l) => l.text).join('\n');
        if (content.length > 0) {
            if (!chomp) text += '\n';
            else if (chomp === '+') text += '\n'.repeat(1 + trailing);
        } else if (chomp === '+') {
            text = '\n'.repeat(trailing);
        }
        const node = stringNode(text, no, (m[5] || '').slice(1).trim());
        node.literal = m[1] === '|';
        return node;
    }
}

function parseYaml(text) {
    return new Parser(text).parse();
}

// Plain JavaScript form of a node, for tests and for comparing against another
// YAML implementation.
function toJS(node) {
    if (node.kind === 'scalar') return node.value;
    if (node.kind === 'seq') return node.items.map(toJS);
    return Object.fromEntries(node.entries.map((e) => [e.key, toJS(e.value)]));
}

module.exports = { parseYaml, toJS, YamlError };
