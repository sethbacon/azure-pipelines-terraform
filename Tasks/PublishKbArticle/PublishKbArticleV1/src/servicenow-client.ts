import { snRequest, withRetry, nonIdempotentCreateRetryError } from './servicenow-http';
import tasks = require('azure-pipelines-task-lib/task');

const WORKFLOW_STATE_MAP: Record<string, string> = {
    draft: 'draft',
    review: 'review',
    publish: 'published',
};

export interface KbArticle {
    sys_id: string;
    number: string;
    short_description: string;
    text?: string;
    workflow_state: string;
    author?: string;
    kb_knowledge_base?: string | { value: string; link?: string };
    meta_description?: string;
    [key: string]: unknown;
}

export interface KbCategory {
    sys_id: string;
    label: string;
    parent?: string | { value: string };
    kb_knowledge_base?: string | { value: string };
}

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
        workflow_state: WORKFLOW_STATE_MAP[workflowState] ?? workflowState,
        author: author,
    };

    if (sourceKey) {
        payload['meta_description'] = `wiki-source: ${sourceKey}`;
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

    // Self-heal: stamp the wiki-source sentinel if missing
    if (sourceKey) {
        const existingMeta = (existing.meta_description as string) || '';
        const sentinel = `wiki-source: ${sourceKey}`;
        if (!existingMeta.includes(sentinel)) {
            payload['meta_description'] = existingMeta ? `${existingMeta}\n${sentinel}` : sentinel;
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
        payload['workflow_state'] = WORKFLOW_STATE_MAP[workflowState] ?? workflowState;
    }
    if (author) payload['author'] = author;

    if (Object.keys(payload).length === 0) {
        throw new Error(tasks.loc('NoFieldsForUpdate'));
    }

    const response = await withRetry(() => snRequest('PATCH', url, { headers, body: payload }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
    assertArticleResult(response.data.result, articleId);
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
    await withRetry(() => snRequest('PATCH', url, { headers, body: { text } }), {
        log: (message) => console.log(`[WARN] ${message}`),
    });
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
    const STATE_VALUE_MAP: Record<string, string> = {
        draft: 'draft',
        review: 'review',
        publish: 'published',
    };

    // encodeURIComponent guards the path segment: an unencoded articleId containing
    // '/', '?', or '#' could otherwise alter the effective REST path/query.
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${encodeURIComponent(articleId)}`;
    const response = await withRetry(() => snRequest('PATCH', url, {
        headers,
        body: { workflow_state: STATE_VALUE_MAP[workflowState] ?? workflowState },
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
 * Find a KB article whose meta_description contains the wiki-source sentinel.
 * Returns the sys_id, null if not found, or throws on key collision (>1 match).
 */
export async function findArticleBySourceKey(
    instance: string,
    headers: Record<string, string>,
    sourceKey: string,
    kbId?: string,
): Promise<string | null> {
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge`;
    assertQueryValueSafe(sourceKey, 'source key');
    if (kbId) assertQueryValueSafe(kbId, 'knowledge base id');
    const sentinel = `wiki-source: ${sourceKey}`;
    let query = `meta_descriptionLIKE${sentinel}`;
    if (kbId) query = `kb_knowledge_base=${kbId}^${query}`;

    const params = {
        sysparm_query: query,
        sysparm_fields: 'sys_id,number,workflow_state,short_description',
        sysparm_limit: '2',
    };

    const response = await withRetry(() => snRequest('GET', url, { headers, params }), { log: logRetry });
    // Array.isArray guard (not a bare cast): the same 2xx-non-JSON-body fallback
    // documented on assertArticleResult applies here -- a malformed response's
    // data defaults to `{}`, which is truthy, so `results || []` alone would keep
    // the object and crash on `results[0]` (#372/#29 follow-up; matches the
    // existing pattern in findOrCreateCategory below).
    const results = Array.isArray(response.data.result) ? (response.data.result as KbArticle[]) : [];

    if (results.length === 0) return null;

    if (results.length > 1) {
        const ids = results.map(r => r.sys_id).join(', ');
        throw new Error(tasks.loc('SourceKeyCollision', sourceKey, ids));
    }

    return results[0].sys_id;
}
