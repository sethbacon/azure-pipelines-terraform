import { snRequest, withRetry, nonIdempotentCreateRetryError } from './servicenow-http';
import tasks = require('azure-pipelines-task-lib/task');

// A Map (not an object literal) so workflowState='__proto__'/'constructor'/etc.
// can never resolve to an inherited Object.prototype member instead of undefined.
const WORKFLOW_STATE_MAP: ReadonlyMap<string, string> = new Map([
    ['draft', 'draft'],
    ['review', 'review'],
    ['publish', 'published'],
]);

export interface KbArticle {
    sys_id: string;
    number: string;
    short_description: string;
    text?: string;
    workflow_state: string;
    author?: string;
    kb_knowledge_base?: string | { value: string; link?: string };
    meta?: string;
    meta_description?: string;
    [key: string]: unknown;
}

export interface KbCategory {
    sys_id: string;
    label: string;
    parent?: string | { value: string };
    kb_knowledge_base?: string | { value: string };
}

/**
 * The ServiceNow REST base URL for an instance name.
 *
 * @egress-reviewed: `instance` is validated against a restrictive charset
 * (letters, digits, hyphens only -- `/^[a-z0-9-]+$/i` at index.ts:83, which
 * throws `InvalidInstance`) before ever reaching this function, so it cannot
 * carry a scheme, a path, another host, or a redirect target -- only a
 * subdomain label under the fixed `.service-now.com` suffix below.
 */
export function baseUrl(instance: string): string {
    return `https://${instance}.service-now.com`;
}

/**
 * Validate that a ServiceNow Table API response's `result` is a single record
 * object (not undefined/null/an array), narrowing it to KbArticle. servicenow-http.ts
 * silently defaults the parsed body to `{}` when a 2xx response fails JSON.parse
 * (e.g. a corporate proxy/WAF intercepting the request and returning 200 with an
 * HTML page), which would otherwise flow through as `undefined` result and crash
 * the caller with a generic TypeError instead of a clear, actionable diagnostic.
 */
function assertArticleResult(result: unknown, context: string): asserts result is KbArticle {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(tasks.loc('ArticleNotObject', context));
    }
}

/**
 * Bounded-retry log helper for the GET/get-or-create calls below (#506):
 * fully idempotent reads (and the naturally-idempotent get-or-create category
 * create) are the safest and most valuable calls to retry on a transient
 * failure -- no ambiguous-outcome risk at all -- yet were previously the only
 * calls in this file NOT wrapped in withRetry, backwards from this repo's own
 * retry rationale (applied correctly to the mutating calls below).
 */
function logRetry(message: string): void {
    console.log(`[WARN] ${message}`);
}

/**
 * The fields an article's source key is kept in, the one to rely on first.
 *
 * `meta` holds the search terms an author adds to an article. It is the
 * author's field rather than one the platform derives from anything else.
 *
 * `meta_description` is where this task kept the key at first, and it is not a
 * safe place for one: it is the description the platform gives to search
 * engines, and an instance may regenerate it from the article body on every
 * save. Where it does, a value a caller writes there does not survive: the key
 * is gone before the following run looks for it, every lookup misses, and every
 * publish with no KB*.json to fall back on creates another article. It is still
 * written on a create and still read, because an instance that leaves the field
 * alone has articles marked there, and a copy of this task not yet carrying this
 * change looks nowhere else.
 */
const SOURCE_KEY_FIELDS = ['meta', 'meta_description'] as const;
type SourceKeyField = typeof SOURCE_KEY_FIELDS[number];

/**
 * The most articles one lookup request may return. The instance's LIKE is a
 * "contains", so a key also selects every article whose key merely contains it
 * ('net-vpc' selects 'net-vpc-peering'), and the exact one is picked out here.
 * A full page means there may be rows that were not returned, so the lookup
 * fails rather than conclude from part of the answer that no article exists.
 */
const SOURCE_KEY_CANDIDATE_LIMIT = 500;

/** The line a source key is stored as. */
function sourceKeySentinel(sourceKey: string): string {
    return `wiki-source: ${sourceKey}`;
}

/**
 * Whether a field's value has a line that ends with the sentinel.
 *
 * The end of a line, not a substring: 'wiki-source: net-vpc' is contained in
 * 'wiki-source: net-vpc-peering', and treating that as a match would publish one
 * document over another. Only the end is pinned, so the key is still found when
 * an editor has joined its line onto the search terms before it; that cannot
 * admit another key, which would have to contain 'wiki-source: ' itself. Case is
 * ignored because the instance's query always ignored it, so two spellings of a
 * key have only ever meant one article.
 */
function hasSentinelLine(value: unknown, sentinel: string): boolean {
    if (typeof value !== 'string') return false;
    const wanted = sentinel.trim().toLowerCase();
    return value.split(/\r?\n/).some((line) => line.trim().toLowerCase().endsWith(wanted));
}

/** A field's value with the sentinel added as its last line. */
function withSentinelLine(value: unknown, sentinel: string): string {
    return typeof value === 'string' && value !== '' ? `${value}\n${sentinel}` : sentinel;
}

/**
 * Warn when a write that carried the source key came back without it.
 *
 * The Table API answers 2xx whether or not it stored a field: a field-level
 * write ACL drops the value silently, and a business rule may replace it. Only
 * the returned record shows which happened, and without this check the first
 * sign was a second article on the next run.
 */
function warnIfSourceKeyNotStored(article: KbArticle, sourceKey: string): void {
    const sentinel = sourceKeySentinel(sourceKey);
    if (SOURCE_KEY_FIELDS.some((field) => hasSentinelLine(article[field], sentinel))) return;
    tasks.warning(tasks.loc('SourceKeyNotStored', sourceKey, article.number || article.sys_id, sentinel));
}

/** Retrieve all knowledge bases. */
export async function getKnowledgeBases(instance: string, headers: Record<string, string>): Promise<unknown[]> {
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge_base`;
    const response = await withRetry(() => snRequest('GET', url, { headers }), { log: logRetry });
    const result = response.data.result;
    if (!Array.isArray(result)) {
        throw new Error(tasks.loc('KbListNotArray'));
    }
    return result;
}

/** Retrieve a single knowledge article by sys_id. */
export async function getArticle(instance: string, headers: Record<string, string>, articleId: string): Promise<KbArticle> {
    // encodeURIComponent guards the path segment: an unencoded articleId containing
    // '/', '?', or '#' could otherwise alter the effective REST path/query.
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${encodeURIComponent(articleId)}`;
    const response = await withRetry(() => snRequest('GET', url, { headers }), { log: logRetry });
    const result = response.data.result;
    assertArticleResult(result, articleId);
    return result;
}

/**
 * Resolve category and subcategory names to a kb_category sys_id.
 * Handles sys_id: prefix for backward compatibility.
 * Returns undefined when no category is needed.
 */
async function resolveKbCategory(
    instance: string,
    headers: Record<string, string>,
    kbId: string,
    category?: string,
    subcategory?: string,
): Promise<string | undefined> {
    if (!category) return undefined;

    if (category.startsWith('sys_id:')) {
        return category.replace('sys_id:', '');
    }

    if (subcategory) {
        const parentId = await findOrCreateCategory(instance, headers, kbId, category, undefined, true);
        if (!parentId) return undefined;
        const subId = await findOrCreateCategory(instance, headers, kbId, subcategory, parentId, true);
        return subId ?? parentId;
    }

    const catId = await findOrCreateCategory(instance, headers, kbId, category, undefined, true);
    return catId ?? undefined;
}

/** Create a new knowledge base article. */
export async function createKnowledgeArticle(
    instance: string,
    headers: Record<string, string>,
    kbId: string,
    title: string,
    text: string,
    author: string,
    category?: string,
    subcategory?: string,
    workflowState: string = 'draft',
    sourceKey?: string,
): Promise<KbArticle> {
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge`;

    const payload: Record<string, unknown> = {
        kb_knowledge_base: kbId,
        short_description: title,
        text: text,
        workflow_state: WORKFLOW_STATE_MAP.get(workflowState) ?? workflowState,
        author: author,
    };

    if (sourceKey) {
        for (const field of SOURCE_KEY_FIELDS) {
            payload[field] = sourceKeySentinel(sourceKey);
        }
    }

    const kbCategoryId = await resolveKbCategory(instance, headers, kbId, category, subcategory);
    if (kbCategoryId) {
        payload['kb_category'] = kbCategoryId;
    }

    const response = await withRetry(() => snRequest('POST', url, { headers, body: payload }), {
        log: (message) => console.log(`[WARN] ${message}`),
        // Audit id18 (2026-07-20): this create is non-idempotent -- do not retry
        // an ambiguous transport failure (the server may have already created the
        // article and only the response was lost), only a definitive 5xx/429.
        retryError: nonIdempotentCreateRetryError,
    });
    assertArticleResult(response.data.result, title);
    if (sourceKey) warnIfSourceKeyNotStored(response.data.result, sourceKey);
    return response.data.result;
}

/** Update an existing knowledge base article. */
export async function updateKnowledgeArticle(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    title?: string,
    text?: string,
    author?: string,
    category?: string,
    subcategory?: string,
    workflowState?: string,
    sourceKey?: string,
): Promise<KbArticle> {
    // encodeURIComponent guards the path segment: an unencoded articleId containing
    // '/', '?', or '#' could otherwise alter the effective REST path/query.
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${encodeURIComponent(articleId)}`;
    const existing = await getArticle(instance, headers, articleId);

    // Extract kb_id (reference fields can be objects or plain strings)
    const kbIdField = existing.kb_knowledge_base;
    const kbId = typeof kbIdField === 'object' && kbIdField !== null
        ? (kbIdField as { value: string }).value
        : kbIdField as string;

    const payload: Record<string, unknown> = {};

    // Self-heal: an article reached by articleId or a KB*.json file may not
    // carry the source key yet. Mark it in Meta, so the key alone finds it next
    // time. meta_description is written only for an article marked nowhere: one
    // already found through it needs no second write to a field the instance
    // may own.
    let marking = false;
    if (sourceKey) {
        const sentinel = sourceKeySentinel(sourceKey);
        if (!hasSentinelLine(existing.meta, sentinel)) {
            payload['meta'] = withSentinelLine(existing.meta, sentinel);
            if (!hasSentinelLine(existing.meta_description, sentinel)) {
                payload['meta_description'] = withSentinelLine(existing.meta_description, sentinel);
            }
            marking = true;
            console.log(`[INFO] Stamping wiki-source sentinel on article ${articleId}`);
        }
    }

    if (title) payload['short_description'] = title;
    // ServiceNow stores the article HTML in `text` only; `body` is not a real
    // column on kb_knowledge and is silently ignored (verified against a live
    // instance — a `body` write round-tripped as empty). Set `text` alone.
    if (text) payload['text'] = text;

    const kbCategoryId = await resolveKbCategory(instance, headers, kbId, category, subcategory);
    if (kbCategoryId) {
        payload['kb_category'] = kbCategoryId;
    }

    if (workflowState) {
        payload['workflow_state'] = WORKFLOW_STATE_MAP.get(workflowState) ?? workflowState;
    }
    if (author) payload['author'] = author;

    if (Object.keys(payload).length === 0) {
        throw new Error(tasks.loc('NoFieldsForUpdate'));
    }

    const response = await withRetry(() => snRequest('PATCH', url, { headers, body: payload }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
    assertArticleResult(response.data.result, articleId);
    if (marking && sourceKey) warnIfSourceKeyNotStored(response.data.result, sourceKey);
    return response.data.result;
}

/**
 * Minimal PATCH of just the article body (text field). Used after image
 * attachments are uploaded to write back the body with rewritten <img src>.
 */
export async function updateArticleBody(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    text: string,
): Promise<void> {
    // encodeURIComponent guards the path segment: an unencoded articleId containing
    // '/', '?', or '#' could otherwise alter the effective REST path/query.
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${encodeURIComponent(articleId)}`;
    const response = await withRetry(() => snRequest('PATCH', url, { headers, body: { text } }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
    assertArticleResult(response.data.result, articleId);
}

/**
 * Set the article's workflow state via the Table API.
 *
 * Publishing is done by patching workflow_state directly. ServiceNow's Table API has no
 * "/publish" action sub-resource — POST .../kb_knowledge/{id}/publish returns HTTP 400
 * "Requested URI does not represent any resource" on every instance — so the PATCH is the
 * supported mechanism, not a fallback.
 */
export async function changeWorkflowState(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    workflowState: string,
): Promise<KbArticle> {
    // A Map (not an object literal) so workflowState='__proto__'/'constructor'/etc.
    // can never resolve to an inherited Object.prototype member instead of undefined.
    const STATE_VALUE_MAP: ReadonlyMap<string, string> = new Map([
        ['draft', 'draft'],
        ['review', 'review'],
        ['publish', 'published'],
    ]);

    // encodeURIComponent guards the path segment: an unencoded articleId containing
    // '/', '?', or '#' could otherwise alter the effective REST path/query.
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${encodeURIComponent(articleId)}`;
    const response = await withRetry(() => snRequest('PATCH', url, {
        headers,
        body: { workflow_state: STATE_VALUE_MAP.get(workflowState) ?? workflowState },
    }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
    assertArticleResult(response.data.result, articleId);
    return response.data.result;
}

/** Retrieve knowledge categories, optionally filtered by KB. */
export async function getKbCategories(
    instance: string,
    headers: Record<string, string>,
    kbId?: string,
): Promise<KbCategory[]> {
    const url = `${baseUrl(instance)}/api/now/table/kb_category`;
    const params: Record<string, string> = {};
    if (kbId) {
        assertQueryValueSafe(kbId, 'knowledge base id');
        params['sysparm_query'] = `kb_knowledge_base=${kbId}`;
    }
    const response = await withRetry(() => snRequest('GET', url, { headers, params }), { log: logRetry });
    return Array.isArray(response.data.result) ? (response.data.result as KbCategory[]) : [];
}

/**
 * Validate that a ServiceNow Table API response's `result` for a category
 * create is a single record object (not undefined/null/an array), narrowing
 * it to KbCategory. Mirrors assertArticleResult -- see its comment for why
 * servicenow-http.ts's 2xx-non-JSON-body fallback (`{}`) needs an explicit
 * guard rather than a silent `(response.data.result || {}) as KbCategory`
 * cast, which gave no diagnostic when ServiceNow returned an unexpected shape
 * (e.g. an array or a string) and silently proceeded with sys_id: undefined --
 * indistinguishable from "category legitimately doesn't exist yet" (#524).
 * Like assertArticleResult, this only validates the shape is a plain object;
 * a valid object missing `sys_id` (e.g. a ServiceNow error body returned with
 * a 2xx status) still falls through to the `|| null` below, preserving
 * resolveKbCategory's existing get-or-create fallback contract.
 */
function assertCategoryResult(result: unknown, context: string): asserts result is KbCategory {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(tasks.loc('CategoryNotObject', context));
    }
}

/** Create a new category (or subcategory) in the given knowledge base. */
export async function createCategory(
    instance: string,
    headers: Record<string, string>,
    kbId: string,
    categoryName: string,
    parentCategoryId?: string,
): Promise<string | null> {
    const url = `${baseUrl(instance)}/api/now/table/kb_category`;
    const payload: Record<string, string> = {
        kb_knowledge_base: kbId,
        label: categoryName,
    };
    if (parentCategoryId) payload['parent'] = parentCategoryId;

    // Let a genuine HTTP/transport error propagate rather than masking it as
    // "category not created", which would silently drop the intended category.
    // The get-or-create create itself is naturally idempotent (a retried POST
    // after a transient failure either creates the category or -- if the first
    // attempt actually succeeded server-side -- would be caught as a duplicate
    // on the next findOrCreateCategory search rather than silently failing the
    // whole publish), so it is retried the same as the mutating calls above.
    const response = await withRetry(() => snRequest('POST', url, { headers, body: payload }), { log: logRetry });
    assertCategoryResult(response.data.result, categoryName);
    return response.data.result.sys_id || null;
}

/**
 * ServiceNow encoded queries use `^` (AND / `^OR` / `^NQ`) and operator tokens as
 * control syntax with no value-escaping mechanism. Any value interpolated into a
 * sysparm_query must be rejected if it contains `^` or a newline, so an operator- or
 * document-derived value (e.g. a markdown front-matter sourceKey) cannot inject query
 * clauses that redirect the lookup onto an unrelated record.
 */
export function assertQueryValueSafe(value: string, field: string): void {
    if (/[\^\r\n]/.test(value)) {
        throw new Error(tasks.loc('InvalidQueryValue', field));
    }
}

/**
 * Find a category by name in the given KB (optionally under a parent), creating
 * it if not found and autoCreate is true.
 * This is the canonical implementation — the Python source had three duplicate
 * definitions; only the third (search-then-create) is preserved here.
 */
export async function findOrCreateCategory(
    instance: string,
    headers: Record<string, string>,
    kbId: string,
    categoryName: string,
    parentCategoryId?: string,
    autoCreate: boolean = true,
): Promise<string | null> {
    const url = `${baseUrl(instance)}/api/now/table/kb_category`;
    assertQueryValueSafe(kbId, 'knowledge base id');
    assertQueryValueSafe(categoryName, 'category name');
    if (parentCategoryId) assertQueryValueSafe(parentCategoryId, 'parent category id');
    let query = `kb_knowledge_base=${kbId}^label=${categoryName}`;
    if (parentCategoryId) query += `^parent=${parentCategoryId}`;

    const params = {
        sysparm_query: query,
        sysparm_fields: 'sys_id,label,parent,kb_knowledge_base',
        sysparm_limit: '1',
    };

    // Let a genuine HTTP/transport error propagate rather than masking it as
    // "category not found", which would silently skip the intended category.
    const response = await withRetry(() => snRequest('GET', url, { headers, params }), { log: logRetry });
    const results = Array.isArray(response.data.result) ? (response.data.result as KbCategory[]) : [];

    if (results.length === 0) {
        if (autoCreate) {
            return createCategory(instance, headers, kbId, categoryName, parentCategoryId);
        }
        return null;
    }

    const found = results[0];
    const foundKbField = found.kb_knowledge_base;
    const foundKbId = typeof foundKbField === 'object' && foundKbField !== null
        ? (foundKbField as { value: string }).value
        : foundKbField as string;

    // If the found category belongs to a different KB, create one in the right KB
    if (foundKbId && foundKbId !== kbId) {
        if (autoCreate) {
            return createCategory(instance, headers, kbId, categoryName, parentCategoryId);
        }
        return null;
    }

    return found.sys_id;
}

/** Thin wrapper: find only, no auto-creation. */
export function findCategoryByName(
    instance: string,
    headers: Record<string, string>,
    kbId: string,
    categoryName: string,
    parentCategoryId?: string,
): Promise<string | null> {
    return findOrCreateCategory(instance, headers, kbId, categoryName, parentCategoryId, false);
}

/**
 * The articles that carry the source key in one field.
 *
 * The query selects on a "contains", so its rows are candidates: each is kept
 * only if the field's returned value has a line ending with the sentinel.
 */
async function findArticlesMarkedIn(
    instance: string,
    headers: Record<string, string>,
    field: SourceKeyField,
    sourceKey: string,
    kbId?: string,
): Promise<KbArticle[]> {
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge`;
    const sentinel = sourceKeySentinel(sourceKey);
    let query = `${field}LIKE${sentinel}`;
    if (kbId) query = `kb_knowledge_base=${kbId}^${query}`;

    const params = {
        sysparm_query: query,
        sysparm_fields: `sys_id,number,workflow_state,short_description,${field}`,
        sysparm_limit: String(SOURCE_KEY_CANDIDATE_LIMIT),
    };

    const response = await withRetry(() => snRequest('GET', url, { headers, params }), { log: logRetry });
    // Array.isArray guard (not a bare cast): the same 2xx-non-JSON-body fallback
    // documented on assertArticleResult applies here -- a malformed response's
    // data defaults to `{}`, which is truthy, so `results || []` alone would keep
    // the object and crash on `results[0]` (#372/#29 follow-up; matches the
    // existing pattern in findOrCreateCategory above).
    const candidates = Array.isArray(response.data.result) ? (response.data.result as KbArticle[]) : [];

    if (candidates.length >= SOURCE_KEY_CANDIDATE_LIMIT) {
        throw new Error(tasks.loc('SourceKeyTooManyCandidates', sourceKey, SOURCE_KEY_CANDIDATE_LIMIT, field));
    }

    // A row with no value for the field cannot be told apart from one marked
    // with a longer key, so it is not taken as a match. It is reported, because
    // the article it may be is about to be duplicated.
    const unconfirmed = candidates.filter((candidate) => typeof candidate[field] !== 'string');
    if (unconfirmed.length > 0) {
        tasks.warning(tasks.loc('SourceKeyMatchUnconfirmed', sourceKey, field, unconfirmed.map((candidate) => candidate.sys_id).join(', ')));
    }

    return candidates.filter((candidate) => hasSentinelLine(candidate[field], sentinel));
}

/**
 * Find the KB article that carries the source key, in Meta or in
 * meta_description (see SOURCE_KEY_FIELDS).
 * Returns the sys_id, null if not found, or throws on key collision (>1 match).
 */
export async function findArticleBySourceKey(
    instance: string,
    headers: Record<string, string>,
    sourceKey: string,
    kbId?: string,
): Promise<string | null> {
    assertQueryValueSafe(sourceKey, 'source key');
    if (kbId) assertQueryValueSafe(kbId, 'knowledge base id');

    // One request per field rather than a single OR: each stands alone, so
    // whatever an instance does with one field cannot hide a match in the other.
    const matched = new Set<string>();
    for (const field of SOURCE_KEY_FIELDS) {
        for (const article of await findArticlesMarkedIn(instance, headers, field, sourceKey, kbId)) {
            matched.add(article.sys_id);
        }
    }

    if (matched.size === 0) return null;

    if (matched.size > 1) {
        throw new Error(tasks.loc('SourceKeyCollision', sourceKey, Array.from(matched).join(', ')));
    }

    return Array.from(matched)[0];
}
