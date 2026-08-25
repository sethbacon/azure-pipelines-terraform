import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadToFile } from '../src/http-client';

/**
 * CLASS TEST — network-retry coverage (#879 / #891).
 *
 * Defect class: "A network operation that can fail transiently is issued
 * WITHOUT the repo's shared retry wrapper, while sibling operations in the
 * same module use it."
 *
 * Table A: downloadToFile's retry-safety behavior -- a transient failure is
 * retried and can still succeed, an egress-authorization rejection is NEVER
 * retried, and a retry never resumes into / corrupts a prior attempt's
 * partial bytes. (The extended tools.downloadTool()/downloadTo() fix for the
 * "official" HashiCorp/OpenTofu/OPA/Sentinel/terraform-docs release path
 * reuses the SAME withRetry-equivalent primitive (retryAsync), already
 * covered directly by RetryL0.ts; see Table B below for its site entries.)
 * Table B: every enumerated outbound network / subprocess-network site in
 * this repo, hand-verdicted (RETRIED / FIXED / EXEMPT), mirroring
 * EgressAuthorizationL0.ts's SITE_ROWS style. Unlike that class test, there is
 * no matching auto-detection script backing this table (out of scope for this
 * batch) -- the file-existence check in each row is a lightweight guard
 * against a row going stale, not a full re-derivation.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('network retry coverage (class test #879/#891)', function () {
    this.timeout(30000);

    describe('A. downloadToFile retry safety', () => {
        let destDir: string;
        let destPath: string;

        beforeEach(() => {
            destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-retry-test-'));
            destPath = path.join(destDir, 'out.bin');
        });

        afterEach(() => {
            fs.rmSync(destDir, { recursive: true, force: true });
        });

        it('retries a transient failure and succeeds on a later attempt', async () => {
            const originalFetch = globalThis.fetch;
            let calls = 0;
            globalThis.fetch = (async () => {
                calls++;
                return calls < 3 ? new Response('boom', { status: 503 }) : new Response('payload', { status: 200 });
            }) as unknown as typeof globalThis.fetch;
            try {
                await downloadToFile('https://artifacts.example.com/x.zip', destPath, 5000, async () => { /* allowed */ });
                assert.strictEqual(calls, 3, 'expected 2 failed attempts then a 3rd that succeeds');
                assert.strictEqual(fs.readFileSync(destPath, 'utf8'), 'payload');
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('gives up after exhausting all attempts on a persistent transient failure', async () => {
            const originalFetch = globalThis.fetch;
            let calls = 0;
            globalThis.fetch = (async () => {
                calls++;
                return new Response('boom', { status: 503 });
            }) as unknown as typeof globalThis.fetch;
            try {
                await assert.rejects(
                    downloadToFile('https://artifacts.example.com/x.zip', destPath, 5000, async () => { /* allowed */ }),
                    /HTTP 503/,
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
            assert.strictEqual(calls, 3, 'total attempts = RETRY_ATTEMPTS (2 retries + the initial try)');
        });

        it('never retries an egress-authorization rejection (a deterministic security decision, not a transient one)', async () => {
            const originalFetch = globalThis.fetch;
            let fetchCalls = 0;
            let authCalls = 0;
            globalThis.fetch = (async () => { fetchCalls++; return new Response('payload', { status: 200 }); }) as unknown as typeof globalThis.fetch;
            try {
                await assert.rejects(
                    downloadToFile('https://artifacts.example.com/x.zip', destPath, 5000, async () => {
                        authCalls++;
                        throw new Error('IS_PRIVATE:blocked-host');
                    }),
                    /IS_PRIVATE:blocked-host/,
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
            assert.strictEqual(authCalls, 1, 'an authorization rejection must never be retried');
            assert.strictEqual(fetchCalls, 0, 'fetch must never be reached once isHostAllowed rejects');
            assert.ok(!fs.existsSync(destPath), 'a rejected download must leave no file behind');
        });

        it('starts each retry attempt from a clean destination -- no append/corruption from a prior failed attempt', async () => {
            const originalFetch = globalThis.fetch;
            let calls = 0;
            globalThis.fetch = (async () => {
                calls++;
                if (calls === 1) {
                    // Simulate a partially-written destination from a prior attempt
                    // (e.g. a mid-stream disconnect after the write stream had
                    // already opened) before this attempt's own request fails.
                    fs.writeFileSync(destPath, 'PARTIAL-FROM-ATTEMPT-1-DO-NOT-KEEP');
                    return new Response('boom', { status: 503 });
                }
                return new Response('full-payload-from-final-attempt', { status: 200 });
            }) as unknown as typeof globalThis.fetch;
            try {
                await downloadToFile('https://artifacts.example.com/x.zip', destPath, 5000, async () => { /* allowed */ });
            } finally {
                globalThis.fetch = originalFetch;
            }
            assert.strictEqual(
                fs.readFileSync(destPath, 'utf8'),
                'full-payload-from-final-attempt',
                'the final file must be exactly the successful attempt\'s bytes, with nothing left over from the failed attempt',
            );
        });

        it('re-runs the egress-authorization check on every attempt, not just the first', async () => {
            const originalFetch = globalThis.fetch;
            let fetchCalls = 0;
            let authCalls = 0;
            globalThis.fetch = (async () => {
                fetchCalls++;
                return fetchCalls < 2 ? new Response('boom', { status: 503 }) : new Response('payload', { status: 200 });
            }) as unknown as typeof globalThis.fetch;
            try {
                await downloadToFile('https://artifacts.example.com/x.zip', destPath, 5000, async () => { authCalls++; });
            } finally {
                globalThis.fetch = originalFetch;
            }
            assert.strictEqual(authCalls, 2, 'isHostAllowed must be re-invoked on every retry attempt, not cached from the first');
        });
    });

    describe('B. every enumerated network / subprocess-network site in this repo', () => {
        type Verdict = 'RETRIED' | 'FIXED' | 'EXEMPT';
        type SiteRow = { file: string; fn: string; sink: string; verdict: Verdict; why: string };

        const SITE_ROWS: SiteRow[] = [
            // --- #879: fixed this batch ---
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/http-client.ts', fn: 'downloadToFile', sink: 'fetchWithTimeout', verdict: 'FIXED', why: '#879: now wrapped in withRetry via attemptDownloadToFile, byte-identical across the 3 installers' },
            { file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/http-client.ts', fn: 'downloadToFile', sink: 'fetchWithTimeout', verdict: 'FIXED', why: '#879, byte-identical copy' },
            { file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/http-client.ts', fn: 'downloadToFile', sink: 'fetchWithTimeout', verdict: 'FIXED', why: '#879, byte-identical copy' },
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts', fn: 'downloadZipFromHashiCorp', sink: 'downloadTo (tools.downloadTool)', verdict: 'FIXED', why: 'extended #879 fix: sibling to the retried fetchText call in the same function; fresh filename per attempt avoids downloadTool\'s own "already exists" hazard' },
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts', fn: 'downloadZipFromOpenTofu', sink: 'downloadTo (tools.downloadTool)', verdict: 'FIXED', why: 'extended #879 fix, same reasoning' },
            { file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts', fn: 'downloadSentinelOfficial', sink: 'downloadTo (tools.downloadTool)', verdict: 'FIXED', why: 'extended #879 fix, same reasoning' },
            { file: 'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src/policy-agent-installer.ts', fn: 'downloadOpaOfficial', sink: 'downloadTo (tools.downloadTool)', verdict: 'FIXED', why: 'extended #879 fix, same reasoning' },
            { file: 'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src/terraform-docs-installer.ts', fn: 'downloadOfficial', sink: 'downloadTo (tools.downloadTool)', verdict: 'FIXED', why: 'extended #879 fix, same reasoning' },
            { file: 'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/policy-source.ts', fn: 'cloneRepo', sink: 'cloneWithRetry (git clone)', verdict: 'FIXED', why: '#891: the one network op in this task, now retried via the shared retry.ts, never retrying an auth/ref-not-found failure' },
            { file: 'Tasks/PublishKbArticle/PublishKbArticleV1/src/attachments.ts', fn: 'deleteAttachment', sink: 'snRequest (DELETE)', verdict: 'FIXED', why: 'sibling to retried listArticleAttachments (GET) / uploadAttachment (POST) in the same file; DELETE is idempotent by HTTP semantics' },

            // --- already retried, unchanged ---
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/http-client.ts', fn: 'fetchJson/fetchText/fetchTextAllow404/fetchBuffer/fetchBufferAllow404', sink: 'fetchWithTimeout', verdict: 'RETRIED', why: 'already wrapped in withRetry; byte-identical across the 3 installers' },
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/gpg-verifier.ts', fn: 'verifyGpgSignature', sink: 'fetchBufferAllow404', verdict: 'RETRIED', why: 'delegates to the retried http-client' },
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/cosign-verifier.ts', fn: 'verifyCosignSignature', sink: 'fetchBufferAllow404', verdict: 'RETRIED', why: 'delegates to the retried http-client' },
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/registry-version-resolver.ts', fn: 'resolveVersionFromRegistry', sink: 'fetchJson', verdict: 'RETRIED', why: 'shared byte-identically across the 3 installers, delegates to the retried http-client' },
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts', fn: 'downloadZipFromRegistry / downloadZipFromMirror', sink: 'downloadToFile / fetchJson / fetchTextAllow404', verdict: 'RETRIED', why: 'already routed through the now-retried downloadToFile and the retried fetch* functions' },
            // TerraformTaskV5's ADO OIDC token request (fetchToken -> fetch) used to sit
            // here as src/id-token-generator.ts. It moved to @4cloudguru/pipeline-task-ado,
            // so it is no longer a site in this repo and carries no row; the retry
            // behaviour travelled with it and is the package's to test.
            { file: 'Tasks/TerraformTask/TerraformTaskV5/src/oci-token-exchange.ts', fn: 'attemptExchange', sink: 'fetch', verdict: 'RETRIED', why: 'wrapped in retryAsync with its own OciTokenExchangeError retryable classification' },
            { file: 'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/hcp-publisher.ts', fn: 'publish (module check / VCS create / version create)', sink: 'this.http via retryHttp', verdict: 'RETRIED', why: 'each is a get-or-create/idempotent call wrapped in retryHttp' },
            { file: 'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/private-publisher.ts', fn: 'publish (module lookup) / createAndLinkModule', sink: 'this.http via retryHttp', verdict: 'RETRIED', why: 'get-or-create module + tolerant-of-409 link, both wrapped in retryHttp' },
            { file: 'Tasks/TerraformDriftReport/TerraformDriftReportV1/src/callback.ts', fn: 'postJsonWithRetry', sink: 'postJson', verdict: 'RETRIED', why: 'retries pure transport failures only; deliberately never retries a RECEIVED response because the callback token is one-shot -- correct as designed, not a gap' },
            { file: 'Tasks/PublishKbArticle/PublishKbArticleV1/src/auth.ts', fn: 'getOAuthToken', sink: 'snRequest (POST)', verdict: 'RETRIED', why: 'the client_credentials grant is idempotent (a repeat just issues a fresh token)' },
            { file: 'Tasks/PublishKbArticle/PublishKbArticleV1/src/servicenow-client.ts', fn: 'every exported function (getArticle, updateKnowledgeArticle, updateArticleBody, changeWorkflowState, etc.)', sink: 'snRequest', verdict: 'RETRIED', why: 'every call site in this file is wrapped in withRetry' },
            { file: 'Tasks/PublishKbArticle/PublishKbArticleV1/src/attachments.ts', fn: 'listArticleAttachments / uploadAttachment', sink: 'snRequest (GET / POST)', verdict: 'RETRIED', why: 'GET uses the default idempotent-read policy; POST uses nonIdempotentCreateRetryError' },

            // --- exempt, with reasons ---
            { file: 'Tasks/TerraformInstaller/TerraformInstallerV1/src/cosign-verifier.ts', fn: 'verifyCosignSignature', sink: 'cosign verify-blob (subprocess)', verdict: 'EXEMPT', why: 'opaque third-party binary invocation; no sibling retried operation in this function; any Sigstore/Rekor network activity happens inside cosign itself, outside this task\'s control' },
            { file: 'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/opa-engine.ts', fn: 'runOpa', sink: 'opa exec (subprocess)', verdict: 'EXEMPT', why: 'sole local subprocess in this module; a policy evaluation failure is generally deterministic (bad bundle/input), not transient' },
            { file: 'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/sentinel-engine.ts', fn: 'runSentinel', sink: 'sentinel apply (subprocess)', verdict: 'EXEMPT', why: 'sole local subprocess in this module, same reasoning as opa-engine.ts' },
            { file: 'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src/policy-source.ts', fn: 'cloneRepo (SHA path)', sink: 'execGit (checkout)', verdict: 'EXEMPT', why: 'local checkout of already-fetched objects -- no network I/O, a failure is deterministic (e.g. a bad SHA)' },
            { file: 'Tasks/TerraformDocs/TerraformDocsV1/src/index.ts', fn: 'run', sink: 'terraform-docs (subprocess)', verdict: 'EXEMPT', why: 'sole subprocess in this task, no sibling retried operation to be asymmetric with; opaque third-party binary' },
            { file: 'Tasks/TerraformTask/TerraformTaskV5/src/azure-terraform-command-handler.ts', fn: 'runAzLogin', sink: 'az login (subprocess)', verdict: 'EXEMPT', why: 'opaque az CLI subprocess with local credential-cache side effects; opt-in (default false); no sibling retried operation in this function; blindly retrying a stateful CLI login is unsafe' },
            { file: 'Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts', fn: 'execWithStdoutCapture / plan / apply / destroy / output', sink: 'terraform/tofu (subprocess)', verdict: 'EXEMPT', why: 'the canonical "deliberately fail-fast" case: state-mutating infrastructure operations must never be blindly retried (a partial apply retried could double-apply or hit provider duplicate-resource errors); terraform\'s own plan/state-lock model is the correct idempotency boundary, not task-level retry' },
            { file: 'Tasks/TerraformTask/TerraformTaskV5/src/secure-file-loader.ts', fn: 'downloadSecureFile', sink: 'azure-pipelines-tasks-securefiles-common (subprocess-adjacent 3rd-party download)', verdict: 'EXEMPT', why: 'NOT-RETRIED-BUT-SHOULD-BE in principle, but not fixed this batch: delegates to a vendored 3rd-party library whose temp-file-reuse-on-retry semantics are opaque from this call site, unlike downloadToFile a retry here cannot be proven to start from a clean destination without reading that library\'s source' },
            { file: 'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/hcp-publisher.ts', fn: 'waitForOk', sink: 'this.http (unwrapped polling GET)', verdict: 'EXEMPT', why: 'already retried by the enclosing poll-until-deadline loop (every 3s); wrapping in retryHttp too would be redundant double-layering, not a gap' },
            { file: 'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/private-publisher.ts', fn: 'waitForVersion', sink: 'this.http (unwrapped polling GET)', verdict: 'EXEMPT', why: 'same reasoning as hcp-publisher.ts waitForOk' },
            { file: 'Tasks/TerraformModulePublish/TerraformModulePublishV1/src/private-publisher.ts', fn: 'publish', sink: 'this.http (unwrapped sync-trigger POST)', verdict: 'EXEMPT', why: 'genuine same-function sibling asymmetry (the GET above it IS retried) and plausibly idempotent by REST convention (202 Accepted async trigger), but the endpoint\'s actual idempotency lives in a different repo (terraform-registry-backend) outside this batch\'s worktree -- NOT independently verifiable from here, so left unwrapped rather than assuming safety' },
        ];

        for (const row of SITE_ROWS) {
            it(`${row.file}: ${row.fn}() -> ${row.sink}() is ${row.verdict}`, () => {
                const fullPath = path.join(REPO_ROOT, row.file);
                assert.ok(fs.existsSync(fullPath), `file no longer exists at the recorded path: ${row.file}`);
                assert.ok(row.why.length > 0, 'every row must carry a reason');
            });
        }

        it('every verdict is one of the three recognized values', () => {
            for (const row of SITE_ROWS) {
                assert.ok(['RETRIED', 'FIXED', 'EXEMPT'].includes(row.verdict), `unrecognized verdict on ${row.file}:${row.fn}`);
            }
        });
    });
});
