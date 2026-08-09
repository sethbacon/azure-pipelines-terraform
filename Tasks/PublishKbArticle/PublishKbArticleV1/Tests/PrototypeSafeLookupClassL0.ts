/**
 * Class test (issues #884/#897): an attacker-influenceable string used as a
 * key into a plain object literal resolves __proto__/constructor/toString/
 * valueOf/hasOwnProperty to an INHERITED Object.prototype member instead of
 * falling through to the not-found branch. This file covers
 * servicenow-client.ts's WORKFLOW_STATE_MAP (createKnowledgeArticle) and
 * STATE_VALUE_MAP (changeWorkflowState), both keyed by the task's
 * `workflowState` input.
 */
import { describe, it } from 'mocha';
import assert = require('assert');
import nock = require('nock');
import * as client from '../src/servicenow-client';

const INSTANCE = 'testinstance';
const BASE_URL = `https://${INSTANCE}.service-now.com`;
const HEADERS = {
  Authorization: 'Bearer test-token',
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

describe('servicenow-client: workflow-state lookup (prototype-pollution class)', () => {
  const legitimateStates: Array<[string, string]> = [
    ['draft', 'draft'],
    ['review', 'review'],
    ['publish', 'published'],
  ];

  for (const [input, expected] of legitimateStates) {
    it(`createKnowledgeArticle maps workflowState='${input}' to workflow_state='${expected}'`, async () => {
      let capturedBody: Record<string, unknown> = {};
      nock(BASE_URL)
        .post('/api/now/table/kb_knowledge', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(201, { result: { sys_id: `art_${input}`, number: 'KB0090', workflow_state: expected } });

      await client.createKnowledgeArticle(
        INSTANCE, HEADERS, 'kb123', 'Title', '<p>HTML</p>', 'author',
        undefined, undefined, input,
      );
      assert.strictEqual(capturedBody['workflow_state'], expected);
    });

    it(`changeWorkflowState maps workflowState='${input}' to workflow_state='${expected}'`, async () => {
      const articleId = `state_${input}`;
      let capturedBody: Record<string, unknown> = {};
      nock(BASE_URL)
        .patch(`/api/now/table/kb_knowledge/${articleId}`, (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, { result: { sys_id: articleId, workflow_state: expected } });

      await client.changeWorkflowState(INSTANCE, HEADERS, articleId, input);
      assert.strictEqual(capturedBody['workflow_state'], expected);
    });
  }

  const prototypePollutionKeys = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  for (const workflowState of prototypePollutionKeys) {
    it(`createKnowledgeArticle passes workflowState='${workflowState}' through as the literal string (an Object.prototype member, not a real state)`, async () => {
      let capturedBody: Record<string, unknown> = {};
      nock(BASE_URL)
        .post('/api/now/table/kb_knowledge', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(201, { result: { sys_id: 'art_x', number: 'KB0091', workflow_state: workflowState } });

      await client.createKnowledgeArticle(
        INSTANCE, HEADERS, 'kb123', 'Title', '<p>HTML</p>', 'author',
        undefined, undefined, workflowState,
      );
      assert.strictEqual(capturedBody['workflow_state'], workflowState);
    });

    it(`changeWorkflowState passes workflowState='${workflowState}' through as the literal string (an Object.prototype member, not a real state)`, async () => {
      const articleId = `state_proto_${workflowState.replace(/[^a-z]/gi, '')}`;
      let capturedBody: Record<string, unknown> = {};
      nock(BASE_URL)
        .patch(`/api/now/table/kb_knowledge/${articleId}`, (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, { result: { sys_id: articleId, workflow_state: workflowState } });

      await client.changeWorkflowState(INSTANCE, HEADERS, articleId, workflowState);
      assert.strictEqual(capturedBody['workflow_state'], workflowState);
    });
  }
});
