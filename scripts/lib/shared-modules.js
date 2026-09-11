// The shared-module lists for this repository. The LOGIC that consumes them is
// scripts/check-shared-modules.js, which is byte-identical across the three
// extensions; these lists are the part that legitimately differs.
//
// FAMILIES   directories that must carry byte-identical copies of the named
//            modules. The first dir is canonical; every other dir's copy must
//            match it exactly.
// PROVENANCE modules copied from ANOTHER repository, which cannot be
//            byte-compared here and must instead carry a machine-checkable
//            provenance header naming their upstream and sync status.

const FAMILIES = [
    {
        // Installer download trust chain: embedded HashiCorp GPG key, the signature
        // verifier, and the raw HTTP client shared by the two installer tasks.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
        ],
        modules: [
            'hashicorp-gpg-key.ts',
            'gpg-verifier.ts',
            'http-client.ts',
        ],
    },
    {
        // Credential-bearing HTTPS transport shared by the registry module publish
        // (API key) and the drift callback (TSM token). The transport itself now
        // comes from @4cloudguru/pipeline-task-core; what these two copies still
        // share is the task-side wiring the package refuses to own -- reading the
        // agent's proxy configuration, registering the credential with the log
        // masker, and the body/timeout/rejectUnauthorized arguments handed to it.
        // Still a real comparison of two real files: a change to how either task
        // constructs its client must land in both.
        dirs: [
            'Tasks/TerraformModulePublish/TerraformModulePublishV1/src',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src',
        ],
        modules: [
            'https-client.ts',
        ],
    },
    {
        // The terraform-docs installer downloads sha256-verified archives from
        // GitHub releases (no GPG/cosign signature), so it shares only the
        // HTTPS-pinned fetch client with the other installers — not the GPG key or
        // verifier. Keep this copy byte-identical with the canonical installer.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'http-client.ts',
        ],
    },
    {
        // Private-registry 'latest' version resolution + operator-URL credential
        // masking helper, shared by all three installer tasks that support
        // downloadSource=registry. Previously hand-duplicated with a matching body
        // in each (issue #681, escaping the parity gate this family now closes) --
        // a fix to the registry-latest error message or masking order could land in
        // one copy and be silently missed in the others.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'registry-version-resolver.ts',
        ],
    },
    {
        // Artifact hashing and platform detection shared by the same three
        // installer tasks: computing a downloaded artifact's SHA256 and comparing
        // it to a published checksum. Previously hand-duplicated inline in each
        // installer with identical bodies (#996).
        //
        // This duplication was invisible to BOTH gates while it lived inline:
        // this script only compares files named in FAMILIES, and
        // check-near-duplicate-modules.js groups by basename, so bodies sitting in
        // terraform-installer.ts, policy-agent-installer.ts and
        // terraform-docs-installer.ts were never compared to each other.
        // Extracting them into one same-named module is what puts them in reach.
        //
        // writeCacheIntegrityMarker/verifyCachedTool are byte-identical across the
        // three too, and are NOT here: the check-artifact-trust gate resolves a
        // CACHE-ADMIT verdict within a single file, so moving them out reports the
        // cache-admission sites as TRUSTS-CACHE-BLINDLY. See the note in
        // tool-integrity.ts.
        dirs: [
            'Tasks/TerraformInstaller/TerraformInstallerV1/src',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/src',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/src',
        ],
        modules: [
            'tool-integrity.ts',
        ],
    },
    {
        // URI-scheme validation shared by the two independent HTML sanitizer/gate
        // layers guarding the ServiceNow KB-publishing pipeline: Markdown2Html's
        // render-time sanitizeRenderedHtml() and PublishKbArticle's downstream
        // fail-closed validateHtmlContent(). Previously each task carried its own
        // drifting copy of this logic, which is exactly how the control-character
        // scheme bypass (#446) evaded both layers at once — keep byte-identical.
        dirs: [
            'Tasks/Markdown2Html/Markdown2HtmlV1/src',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src',
        ],
        modules: [
            'uri-scheme-guard.ts',
        ],
    },
    {
        // The allowlist HTML sanitizer itself (#820): before this, PublishKbArticle's
        // raw htmlFile input was only ever DENYLIST-validated (html-validate.ts) and
        // then published VERBATIM, so a bypass of that denylist reached ServiceNow's
        // stored-XSS sink unfiltered. Both the KB-publishing pipeline's independent
        // entry points — Markdown2Html's render-time convertMarkdownToHtml() and
        // PublishKbArticle's pre-publish sanitizeHtmlForPublish() — must apply the
        // SAME allowlist policy (including the #835 rel="noopener noreferrer"
        // forcing on <a target=…>), or a KB article published one way could carry
        // active content a KB article published the other way would have stripped.
        dirs: [
            'Tasks/Markdown2Html/Markdown2HtmlV1/src',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src',
        ],
        modules: [
            'html-sanitizer.ts',
        ],
    },
    {
        // The migration notice both KB-publishing tasks emit on every run while
        // they move to azure-pipelines-release-docs. Shared for the same reason
        // the sanitizers above are: it states WHERE these tasks are going and
        // WHAT they will be called, and two tasks migrating to one destination
        // must not answer that in two ways. A corrected URL, a changed
        // replacement name or a revised cutover story applied to one task and
        // missed in the other is precisely how a consumer ends up following a
        // stale instruction (#55).
        dirs: [
            'Tasks/Markdown2Html/Markdown2HtmlV1/src',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src',
        ],
        modules: [
            'deprecation-notice.ts',
        ],
    },
    {
        // Frozen plan/apply digest CONTRACT shared between the task that PRODUCES
        // the redacted digest (src/results/) and the build-results tab that
        // CONSUMES it (src/tab/). digest-schema.ts is the versioned TypeScript
        // shape; caps.ts is the single source of the §6 size/DoS limits. A drift
        // between producer and consumer here would silently break redaction/size
        // guarantees or the render contract, so keep byte-identical (design
        // decision D4). NOTE: unlike the installer families above, the second dir
        // is the repo-root tab source (not under Tasks/), so the self-test
        // (scripts/test-check-shared-modules.js) copies src/ as well as Tasks/.
        dirs: [
            'Tasks/TerraformTask/TerraformTaskV5/src/results',
            'src/tab',
        ],
        modules: [
            'digest-schema.ts',
            'caps.ts',
        ],
        // NOTE: redact.ts (the recursive redaction core) is NOT listed here. It
        // has only one copy — Tasks/TerraformTask/TerraformTaskV5/src/results/
        // redact.ts — since only the task PRODUCES a digest; the tab CONSUMES an
        // already-redacted one and never re-implements redaction. There is
        // nothing to byte-compare it against, so it is deliberately excluded
        // from this family rather than silently forgotten (design §9/§5.2.6).
        // If a redact.ts (or equivalent) copy is ever bundled into src/tab/, add
        // it to `modules` above in the same commit.
        //
        // Phase 5 (destroy/state): state-digest.ts is the same single-copy
        // pattern as redact.ts — only the task produces a StateDigest, so it is
        // also NOT listed here. The StateDigest TYPE and the state caps
        // (MAX_STATE_RESOURCES / MAX_STATE_ATTRS_PER_RESOURCE) landed as
        // additive members of the EXISTING digest-schema.ts / caps.ts files
        // above, so this family already covers them; destroy needed no schema
        // change at all (it reuses PlanDigest via the optional `planMode`
        // field). No new family was needed for Phase 5.
    },
    {
        // Wall-clock deadline wrapper for a local subprocess (execWithTimeout +
        // the shared TOOL_EXEC_TIMEOUT_MS ceiling): a Promise.race deadline that
        // kills the child on timeout, generalizing policy-source.ts's git-clone
        // pattern for the policy-engine (opa/sentinel) and terraform-docs
        // invocations that previously had only an output-byte cap and no
        // wall-clock bound (#782). A drift here could silently drop the timeout in
        // one task while the other keeps failing fast, so keep byte-identical.
        dirs: [
            'Tasks/TerraformPolicyCheck/TerraformPolicyCheckV1/src',
            'Tasks/TerraformDocs/TerraformDocsV1/src',
        ],
        modules: [
            'exec-timeout.ts',
        ],
    },
    {
        // Realpath-based containment guard (`isWithinWorkingDirectory`): resolves
        // symlinks on both sides before comparing, so an in-tree symlink pointing
        // outside the base directory cannot pass a purely lexical prefix check.
        // Carried by every task that resolves a CONTENT-supplied path (front-matter
        // `includes:`, `<img src>`, a module manifest) before reading it. Operator-
        // supplied output paths are deliberately NOT guarded -- see the comment in
        // Markdown2HtmlV1/src/converter.ts. A drift would silently reopen the
        // traversal on one task while the others stay closed, so keep byte-identical.
        dirs: [
            'Tasks/Markdown2Html/Markdown2HtmlV1/src',
            'Tasks/PublishKbArticle/PublishKbArticleV1/src',
            'Tasks/TerraformDriftReport/TerraformDriftReportV1/src',
        ],
        modules: [
            'path-containment.ts',
        ],
    },
    {
        // The resolver that finds a class gate this repository no longer carries.
        // check-proxy-parity, check-artifact-trust, auth-parity-matrix,
        // check-enforced-disciplines and now check-egress-authorization moved to
        // 4cloudguru/shared-workflows as composite actions; the four that task L0
        // suites SPAWN are found through this file -- the composite's exported
        // github.action_path on a runner, a sibling shared-workflows checkout for a
        // developer, and a throw otherwise. It encodes no verdict: it returns a
        // path or it fails. Copies also live in azure-pipelines-packer's two task
        // Tests/ directories, declared there by a PROVENANCE entry naming this
        // repository as the upstream; within THIS repository the four copies are
        // byte-compared here, which is what stops a fix to the resolver landing in
        // one task's suite and not another's.
        //
        // EVERY DIRECTORY HOLDING A COPY MUST BE LISTED. This list is not a
        // sample: check-shared-modules.js compares only what it is given, so a
        // copy that exists on disk and not here is a file nothing is watching --
        // which is the same failure the family exists to refuse. The last two
        // arrived with the egress gate's move to a composite, when
        // PolicyAgentInstallerV1 and TerraformDocsInstallerV1 stopped spawning
        // scripts/ and started resolving through this module.
        //
        // A Tests/ family, unlike every src/ family above: the module is test
        // infrastructure, so this is also the first family whose dirs the
        // self-test's Tasks/ copy has to carry.
        dirs: [
            'Tasks/TerraformTask/TerraformTaskV5/Tests',
            'Tasks/TerraformInstaller/TerraformInstallerV1/Tests',
            'Tasks/PolicyAgentInstaller/PolicyAgentInstallerV1/Tests',
            'Tasks/TerraformDocsInstaller/TerraformDocsInstallerV1/Tests',
        ],
        modules: [
            'shared-gate.ts',
        ],
    },
];

// Cross-repository copies: modules this repository copied FROM another one. A
// row here is what lets the replay's cross-repo-copy-parity signature compare
// the body of the copy against the upstream's live main (header stripped on
// both sides), so a fix landed upstream that never reached here is a site
// rather than a silent divergence. `dir` and `file` locate the copy here; the
// upstream's own path comes from the copy's `@shared-module: copied from ...`
// header, which scripts/check-shared-modules.js requires to name the same
// upstream as the row.
//
// Tests/shared-gate.ts (the class-gate resolver) came from
// azure-pipelines-packer, which holds the canonical copy: it landed there first
// (sethbacon/azure-pipelines-packer#455). One row is enough -- the FAMILIES
// entry above holds this repository's other three copies byte-identical to this
// one (sethbacon/azure-pipelines-terraform#1167), so comparing this row against
// the upstream transitively covers all four.
const PROVENANCE = [
    { dir: 'Tasks/TerraformTask/TerraformTaskV5/Tests', file: 'shared-gate.ts', upstream: 'azure-pipelines-packer' },
];

module.exports = { FAMILIES, PROVENANCE };
