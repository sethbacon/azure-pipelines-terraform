// Full-task test (#820): dryRun=false, no existing articleId -> real CREATE
// path, using a FULL HTML document htmlFile (exercising sanitizeHtmlForPublish's
// primary real-parser head/body branch, not the bare-fragment else branch)
// containing a tag the DENYLIST gate (validateHtmlContent) allows through but
// the shared ALLOWLIST sanitizer (html-sanitizer.ts) does not. <marquee> is not
// in the historical DANGEROUS_TAGS denylist, so validateHtmlContent lets it
// through; proving it is stripped from the content actually handed to
// createKnowledgeArticle -- while the legitimate head <style> is preserved --
// demonstrates the new allowlist re-serialization layer, not just the
// pre-existing denylist, is doing the sanitization work on this path.
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');
import fs = require('fs');
import os = require('os');

const tp = path.join(__dirname, '..', 'src', 'index.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(tp);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-create-sanitize-'));
const htmlFile = path.join(dir, 'article.html');
fs.writeFileSync(htmlFile, '<!DOCTYPE html><html><head><title>Sanitized Article</title>'
  + '<style>.hljs{color:red}</style></head><body><p>Real content</p><marquee>drop me</marquee></body></html>');

tr.setInput('instance', 'my-valid-instance');
tr.setInput('authType', 'basic');
tr.setInput('username', 'svc-user');
tr.setInput('password', 'svc-pass');
tr.setInput('kbId', 'kb-123');
tr.setInput('title', 'Sanitized Article');
tr.setInput('htmlFile', htmlFile);
tr.setInput('author', 'jdoe');
tr.setInput('workflowState', 'draft');
tr.setInput('dryRun', 'false');
tr.setInput('skipJsonLookup', 'true');
tr.setInput('force', 'false');
tr.setInput('uploadImages', 'false');
tr.setInput('emitManifest', path.join(dir, 'manifest.json'));

tr.registerMock('./servicenow-client', {
  createKnowledgeArticle: async (instance: string, _headers: unknown, kbId: string, title: string, content: string, author: string) => {
    console.log(`##[MOCK] createKnowledgeArticle called with instance=${instance} kbId=${kbId} title=${title} author=${author} contentSanitized=${!content.includes('<marquee')} stylePreserved=${content.includes('.hljs{color:red}')} content=${content}`);
    return { sys_id: 'new-sys-id', number: 'KB0099', workflow_state: 'draft' };
  },
  getKnowledgeBases: async () => [],
});

const a: ma.TaskLibAnswers = {};
tr.setAnswers(a);
tr.run();
