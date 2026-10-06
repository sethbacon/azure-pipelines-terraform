// A stateful stand-in for the ServiceNow Table API's kb_knowledge table.
//
// The other servicenow-client tests answer each request with a canned reply, so
// a value written by one call is never the value a later call reads back. That
// is exactly the property the source key depends on: createKnowledgeArticle
// writes it, and findArticleBySourceKey on the NEXT run has to find it. This
// keeps the rows in memory, evaluates the encoded query against them, and can
// apply the two things a real instance does to a write that a canned reply
// never will:
//
//   rewriteMetaDescription  regenerate meta_description from the article body on
//                           every save, the way the platform's own business rule
//                           does, discarding whatever the caller wrote there.
//   readOnlyFields          drop the caller's value for those fields and still
//                           answer 2xx, which is what a field-level write ACL
//                           does through the Table API.
//   hiddenFields            leave those fields out of every response while still
//                           matching queries on them (a field-level read ACL).
//
// It understands only the encoded-query operators this client sends (`=`, `LIKE`
// and `ORDERBY`), and throws on anything else so a test cannot pass against a
// query the fake silently ignored.
import nock = require('nock');

export interface FakeKbOptions {
    rewriteMetaDescription?: boolean;
    readOnlyFields?: string[];
    hiddenFields?: string[];
}

export interface FakeKbRequest {
    method: 'GET' | 'POST' | 'PATCH';
    path: string;
    params: Record<string, string>;
    body: Record<string, unknown>;
}

export interface FakeKbInstance {
    /** Every request received, in order. */
    requests: FakeKbRequest[];
    /** The stored row for a sys_id, as the instance holds it (hidden fields included). */
    row(sysId: string): Record<string, string> | undefined;
    /** Insert a row directly, bypassing the write rules: an article that already existed. */
    seed(fields: Record<string, string>): Record<string, string>;
}

const TABLE_PATH = '/api/now/table/kb_knowledge';

function plainText(html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchesTerm(row: Record<string, string>, term: string): boolean {
    if (term.startsWith('ORDERBY')) {
        return true;
    }
    const parsed = /^([a-z_]+)(LIKE|=)([\s\S]*)$/.exec(term);
    if (!parsed) {
        throw new Error(`fake kb_knowledge: unsupported encoded-query term '${term}'`);
    }
    const [, field, operator, value] = parsed;
    const stored = row[field] ?? '';
    return operator === '='
        ? stored === value
        // The instance's LIKE is a case-insensitive "contains".
        : stored.toLowerCase().includes(value.toLowerCase());
}

export function fakeKbInstance(baseUrl: string, options: FakeKbOptions = {}): FakeKbInstance {
    const rows = new Map<string, Record<string, string>>();
    const requests: FakeKbRequest[] = [];
    const readOnly = new Set(options.readOnlyFields ?? []);
    const hidden = new Set(options.hiddenFields ?? []);
    let sequence = 0;

    const nextIdentity = (): { sys_id: string; number: string } => {
        sequence += 1;
        return {
            sys_id: sequence.toString(16).padStart(32, '0'),
            number: `KB${String(sequence).padStart(7, '0')}`,
        };
    };

    const save = (row: Record<string, string>, incoming: Record<string, unknown>): void => {
        for (const [field, value] of Object.entries(incoming)) {
            if (!readOnly.has(field)) {
                row[field] = String(value);
            }
        }
        if (options.rewriteMetaDescription) {
            row['meta_description'] = plainText(row['text'] ?? '').slice(0, 100);
        }
    };

    const visible = (row: Record<string, string>, fields?: string): Record<string, string> => {
        const wanted = fields ? new Set(fields.split(',')) : undefined;
        const shown: Record<string, string> = {};
        for (const [field, value] of Object.entries(row)) {
            if (!hidden.has(field) && (!wanted || wanted.has(field))) {
                shown[field] = value;
            }
        }
        return shown;
    };

    const record = (method: FakeKbRequest['method'], uri: string, body: unknown): FakeKbRequest => {
        const url = new URL(uri, baseUrl);
        // nock hands a JSON body over already parsed when the request said it was
        // JSON, and as the raw string otherwise.
        const parsedBody: unknown = typeof body === 'string' && body !== '' ? JSON.parse(body) : body;
        const request: FakeKbRequest = {
            method,
            path: url.pathname,
            params: Object.fromEntries(url.searchParams.entries()),
            body: (parsedBody && typeof parsedBody === 'object' ? parsedBody : {}) as Record<string, unknown>,
        };
        requests.push(request);
        return request;
    };

    const sysIdOf = (path: string): string => decodeURIComponent(path.slice(TABLE_PATH.length + 1));
    const byId = new RegExp(`^${TABLE_PATH}/[^/?]+$`);

    nock(baseUrl)
        .persist()
        .post(TABLE_PATH)
        .reply((uri, body) => {
            const request = record('POST', uri, body);
            const row: Record<string, string> = { ...nextIdentity() };
            save(row, request.body);
            rows.set(row['sys_id'], row);
            return [201, { result: visible(row) }];
        })
        .get(TABLE_PATH)
        .query(true)
        .reply((uri) => {
            const request = record('GET', uri, undefined);
            const terms = (request.params['sysparm_query'] ?? '').split('^').filter((term) => term !== '');
            const limit = Number(request.params['sysparm_limit'] ?? '10000');
            const matched = [...rows.values()].filter((row) => terms.every((term) => matchesTerm(row, term)));
            return [200, { result: matched.slice(0, limit).map((row) => visible(row, request.params['sysparm_fields'])) }];
        })
        .get(byId)
        .reply((uri) => {
            const request = record('GET', uri, undefined);
            const row = rows.get(sysIdOf(request.path));
            return row ? [200, { result: visible(row) }] : [404, { error: { message: 'No Record found' } }];
        })
        .patch(byId)
        .reply((uri, body) => {
            const request = record('PATCH', uri, body);
            const row = rows.get(sysIdOf(request.path));
            if (!row) {
                return [404, { error: { message: 'No Record found' } }];
            }
            save(row, request.body);
            return [200, { result: visible(row) }];
        });

    return {
        requests,
        row: (sysId) => rows.get(sysId),
        seed: (fields) => {
            const row: Record<string, string> = { ...nextIdentity(), ...fields };
            rows.set(row['sys_id'], row);
            return row;
        },
    };
}
