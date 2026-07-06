import { snRequest } from './servicenow-http';

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

/** Retrieve all knowledge bases. */
export async function getKnowledgeBases(instance: string, headers: Record<string, string>): Promise<unknown[]> {
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge_base`;
    const response = await snRequest('GET', url, { headers });
    const result = response.data.result;
    if (!Array.isArray(result)) {
        throw new Error('Unexpected ServiceNow response: the knowledge-base list endpoint did not return an array in "result".');
    }
    return result;
}

/** Retrieve a single knowledge article by sys_id. */
export async function getArticle(instance: string, headers: Record<string, string>, articleId: string): Promise<KbArticle> {
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${articleId}`;
    const response = await snRequest('GET', url, { headers });
    const result = response.data.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`Unexpected ServiceNow response: no article object in "result" for article ${articleId}.`);
    }
    return result as KbArticle;
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

    const response = await snRequest('POST', url, { headers, body: payload });
    return response.data.result as KbArticle;
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
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${articleId}`;
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
        throw new Error('No fields provided for update.');
    }

    const response = await snRequest('PATCH', url, { headers, body: payload });
    return response.data.result as KbArticle;
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
    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${articleId}`;
    await snRequest('PATCH', url, { headers, body: { text } });
}

/**
 * Change workflow state using the /publish endpoint first (for publish),
 * falling back to a standard PATCH on failure.
 */
export async function changeWorkflowState(
    instance: string,
    headers: Record<string, string>,
    articleId: string,
    workflowState: string,
): Promise<KbArticle> {
    if (workflowState === 'publish') {
        const publishUrl = `${baseUrl(instance)}/api/now/table/kb_knowledge/${articleId}/publish`;
        try {
            console.log('Attempting to publish article using workflow action...');
            const response = await snRequest('POST', publishUrl, { headers, body: {} });
            if ([200, 201, 204].includes(response.status)) {
                console.log('Article published successfully using workflow action.');
                return await getArticle(instance, headers, articleId);
            }
        } catch {
            console.log('Workflow action failed. Falling back to standard update...');
        }
    }

    const STATE_VALUE_MAP: Record<string, string> = {
        draft: 'draft',
        review: 'review',
        publish: 'published',
    };

    const url = `${baseUrl(instance)}/api/now/table/kb_knowledge/${articleId}`;
    const response = await snRequest('PATCH', url, {
        headers,
        body: { workflow_state: STATE_VALUE_MAP[workflowState] ?? workflowState },
    });
    return response.data.result as KbArticle;
}

/** Retrieve knowledge categories, optionally filtered by KB. */
export async function getKbCategories(
    instance: string,
    headers: Record<string, string>,
    kbId?: string,
): Promise<KbCategory[]> {
    const url = `${baseUrl(instance)}/api/now/table/kb_category`;
    const params: Record<string, string> = {};
    if (kbId) params['sysparm_query'] = `kb_knowledge_base=${kbId}`;
    const response = await snRequest('GET', url, { headers, params });
    return response.data.result as KbCategory[];
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
    const response = await snRequest('POST', url, { headers, body: payload });
    const result = (response.data.result || {}) as KbCategory;
    return result.sys_id || null;
}

/**
 * ServiceNow encoded queries use `^` (AND / `^OR` / `^NQ`) and operator tokens as
 * control syntax with no value-escaping mechanism. Any value interpolated into a
 * sysparm_query must be rejected if it contains `^` or a newline, so an operator- or
 * document-derived value (e.g. a markdown front-matter sourceKey) cannot inject query
 * clauses that redirect the lookup onto an unrelated record.
 */
function assertQueryValueSafe(value: string, field: string): void {
    if (/[\^\r\n]/.test(value)) {
        throw new Error(`Invalid ${field}: values used in a ServiceNow query must not contain '^' or newline characters.`);
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
    const response = await snRequest('GET', url, { headers, params });
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

    const response = await snRequest('GET', url, { headers, params });
    const results = (response.data.result || []) as KbArticle[];

    if (results.length === 0) return null;

    if (results.length > 1) {
        const ids = results.map(r => r.sys_id).join(', ');
        throw new Error(
            `Key collision: multiple articles found for source key '${sourceKey}' (sys_ids: ${ids}).`,
        );
    }

    return results[0].sys_id;
}
