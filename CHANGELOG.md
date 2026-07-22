# Changelog

All notable changes to **Pipeline Tasks for Terraform** (`sethbacon.pipeline-tasks-terraform`) are documented here.

This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [semantic versioning](https://semver.org/).

## [1.11.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.11.0...v1.11.1) (2026-07-22)


### Bug Fixes

* audit-2026-07-21 remediation - low/info findings (batches F-I) ([#774](https://github.com/sethbacon/azure-pipelines-terraform/issues/774)) ([e18ea95](https://github.com/sethbacon/azure-pipelines-terraform/commit/e18ea9538bcd9958955fca1af0cb667ccb39c660))
* audit-2026-07-21 remediation - regressions + medium findings (batches A-E) ([#772](https://github.com/sethbacon/azure-pipelines-terraform/issues/772)) ([b0b776b](https://github.com/sethbacon/azure-pipelines-terraform/commit/b0b776b0b1577c7c26b27d5fccab7f2e03cc9fca))

## [1.11.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.6...v1.11.0) (2026-07-21)


### Features

* **v5:** real-terraform smoke harness -- Workstream 1 of [#719](https://github.com/sethbacon/azure-pipelines-terraform/issues/719) ([#751](https://github.com/sethbacon/azure-pipelines-terraform/issues/751)) ([812684b](https://github.com/sethbacon/azure-pipelines-terraform/commit/812684b7ddf80188a9370cd715a794de36d36daf))


### Bug Fixes

* accept OpenTofu's release-branch signing identity for 1.12.x patch releases ([#738](https://github.com/sethbacon/azure-pipelines-terraform/issues/738)) ([d6a0c31](https://github.com/sethbacon/azure-pipelines-terraform/commit/d6a0c31d0f63a123dab37250c60407f5499575c4)), closes [#714](https://github.com/sethbacon/azure-pipelines-terraform/issues/714)
* **ci:** dedup scheduled-scan issues instead of filing a new one every week ([#747](https://github.com/sethbacon/azure-pipelines-terraform/issues/747)) ([81813e5](https://github.com/sethbacon/azure-pipelines-terraform/commit/81813e5ba0f66f7ec6f2524eb1ba81460da4c190)), closes [#724](https://github.com/sethbacon/azure-pipelines-terraform/issues/724)
* **deps:** update tar to patch critical PAX path-confusion/DoS CVEs ([#744](https://github.com/sethbacon/azure-pipelines-terraform/issues/744)) ([24630bd](https://github.com/sethbacon/azure-pipelines-terraform/commit/24630bd19c1b66d726a8b8d72c4144fe17f92ed5))
* destroy+publishPlanSummary against real terraform, and surface apply's -json diagnostic on failure ([#749](https://github.com/sethbacon/azure-pipelines-terraform/issues/749), [#750](https://github.com/sethbacon/azure-pipelines-terraform/issues/750)) ([#752](https://github.com/sethbacon/azure-pipelines-terraform/issues/752)) ([a2d4a27](https://github.com/sethbacon/azure-pipelines-terraform/commit/a2d4a27ab448e0fa6cf36af49d36e40487216311))
* distinguish stale-docs failure from crash, and warn on real getArticle errors in dry-run ([#743](https://github.com/sethbacon/azure-pipelines-terraform/issues/743)) ([8877d1c](https://github.com/sethbacon/azure-pipelines-terraform/commit/8877d1c263f60bcbc24365f5a053628f147c99c6)), closes [#726](https://github.com/sethbacon/azure-pipelines-terraform/issues/726) [#727](https://github.com/sethbacon/azure-pipelines-terraform/issues/727)
* **installer:** stream SHA256 hashing + reject private/link-local hosts by default ([#745](https://github.com/sethbacon/azure-pipelines-terraform/issues/745)) ([8350860](https://github.com/sethbacon/azure-pipelines-terraform/commit/8350860a512ad0c358bfab70604389f7e89ade01))


### Documentation

* clarify Node 24 is the sole behavioral test gate, Node 20 is load-only ([#720](https://github.com/sethbacon/azure-pipelines-terraform/issues/720)) ([#748](https://github.com/sethbacon/azure-pipelines-terraform/issues/748)) ([17a668e](https://github.com/sethbacon/azure-pipelines-terraform/commit/17a668e99fb2b736a9086ca8c73e00544c3d8311))
* correct stale retry-family task count and Key Dependencies HTML sanitizer entries ([#739](https://github.com/sethbacon/azure-pipelines-terraform/issues/739)) ([124f5b3](https://github.com/sethbacon/azure-pipelines-terraform/commit/124f5b30686aea7e6600fc87f1fcc57a609f8d83)), closes [#725](https://github.com/sethbacon/azure-pipelines-terraform/issues/725) [#733](https://github.com/sethbacon/azure-pipelines-terraform/issues/733)
* move smoke-fuzz plan to docs/initiatives, link from README ([#734](https://github.com/sethbacon/azure-pipelines-terraform/issues/734)) ([0c1480c](https://github.com/sethbacon/azure-pipelines-terraform/commit/0c1480c7394cdfdec0040e65306df06eea19ca61))


### Refactor

* resolve DigestMeta name collision, gate HTTP hardening constants, dedupe az login exec ([#740](https://github.com/sethbacon/azure-pipelines-terraform/issues/740)) ([95ded79](https://github.com/sethbacon/azure-pipelines-terraform/commit/95ded7940ac9f3b109eb66ab0286405b5b325b22)), closes [#721](https://github.com/sethbacon/azure-pipelines-terraform/issues/721) [#722](https://github.com/sethbacon/azure-pipelines-terraform/issues/722) [#732](https://github.com/sethbacon/azure-pipelines-terraform/issues/732)


### Security

* refresh brace-expansion to clear a new HIGH-severity DoS advisory ([#742](https://github.com/sethbacon/azure-pipelines-terraform/issues/742)) ([e2df7e1](https://github.com/sethbacon/azure-pipelines-terraform/commit/e2df7e1796ddc67f68656debc767c3b84f3ccc61))
* remediate 5 mediums from the 2026-07-20 blind audit ([#735](https://github.com/sethbacon/azure-pipelines-terraform/issues/735)) ([e5651b0](https://github.com/sethbacon/azure-pipelines-terraform/commit/e5651b0c040e1a47b756f7ef40176a0e5785e1e6))

## [1.10.6](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.5...v1.10.6) (2026-07-20)


### Bug Fixes

* add decorrelated jitter and an optional wall-clock budget to the shared retry backoff ([#692](https://github.com/sethbacon/azure-pipelines-terraform/issues/692)) ([#711](https://github.com/sethbacon/azure-pipelines-terraform/issues/711)) ([dce7b11](https://github.com/sethbacon/azure-pipelines-terraform/commit/dce7b117b9c3d35bff546656dac08ffbcf78b05e))
* broaden Minor-bump gate to cover task.json-only changes ([#676](https://github.com/sethbacon/azure-pipelines-terraform/issues/676)) ([#705](https://github.com/sethbacon/azure-pipelines-terraform/issues/705)) ([babbaa2](https://github.com/sethbacon/azure-pipelines-terraform/commit/babbaa26e778d18e231da8369565d6ea7bb36af8))
* cap local image/HTML file reads in PublishKbArticle ([#700](https://github.com/sethbacon/azure-pipelines-terraform/issues/700)) ([270faf3](https://github.com/sethbacon/azure-pipelines-terraform/commit/270faf32935ffdc9d3ea1349fee0fbeb4923696f))
* close CodeQL-flagged TOCTOU races and command injection ([#703](https://github.com/sethbacon/azure-pipelines-terraform/issues/703)) ([7a1cc82](https://github.com/sethbacon/azure-pipelines-terraform/commit/7a1cc82819f29c2a4d8a19e92526a26f37a1c206))
* enforce registryAllowedHosts across the whole redirect chain ([#701](https://github.com/sethbacon/azure-pipelines-terraform/issues/701)) ([559b1d6](https://github.com/sethbacon/azure-pipelines-terraform/commit/559b1d640c91199ac54faf5f084e2515afac66de))
* mask percent-encoded proxy password and thread known secrets into apply summary scrub ([#684](https://github.com/sethbacon/azure-pipelines-terraform/issues/684), [#694](https://github.com/sethbacon/azure-pipelines-terraform/issues/694)) ([#710](https://github.com/sethbacon/azure-pipelines-terraform/issues/710)) ([6c28e3b](https://github.com/sethbacon/azure-pipelines-terraform/commit/6c28e3b068c631297f793d6b34702e45c2923775))
* neutralize ##vso injection in echoed apply [@message](https://github.com/message) ([#698](https://github.com/sethbacon/azure-pipelines-terraform/issues/698)) ([8fabfd4](https://github.com/sethbacon/azure-pipelines-terraform/commit/8fabfd4417dcb4d263ece48d8070e29e386ec3fd)), closes [#678](https://github.com/sethbacon/azure-pipelines-terraform/issues/678)
* never echo captured terraform stdout to the log ([#702](https://github.com/sethbacon/azure-pipelines-terraform/issues/702)) ([2fc9579](https://github.com/sethbacon/azure-pipelines-terraform/commit/2fc95793fe70e175093f77895ce008d1debabb02)), closes [#492](https://github.com/sethbacon/azure-pipelines-terraform/issues/492)
* opt-in scrub of cached OCI PAR backend credential ([#699](https://github.com/sethbacon/azure-pipelines-terraform/issues/699)) ([ee0c36e](https://github.com/sethbacon/azure-pipelines-terraform/commit/ee0c36e44771b7e57525a7257900c36ca41ca162)), closes [#675](https://github.com/sethbacon/azure-pipelines-terraform/issues/675)
* remove unreachable duplicate auth validation, neutralize echoed ServiceNow fields ([#683](https://github.com/sethbacon/azure-pipelines-terraform/issues/683), [#693](https://github.com/sethbacon/azure-pipelines-terraform/issues/693)) ([#709](https://github.com/sethbacon/azure-pipelines-terraform/issues/709)) ([8b8740e](https://github.com/sethbacon/azure-pipelines-terraform/commit/8b8740e7d181644377114936de2ebfe5ac7e604f))


### Refactor

* centralize duplicated auth-scheme resolution and registry version resolution ([#681](https://github.com/sethbacon/azure-pipelines-terraform/issues/681), [#682](https://github.com/sethbacon/azure-pipelines-terraform/issues/682)) ([#708](https://github.com/sethbacon/azure-pipelines-terraform/issues/708)) ([da2a6a6](https://github.com/sethbacon/azure-pipelines-terraform/commit/da2a6a6224cd9594e94ef97fdfcd454509497f48))

## [1.10.5](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.4...v1.10.5) (2026-07-19)


### Bug Fixes

* deepen installer verification and complete retry unification ([#669](https://github.com/sethbacon/azure-pipelines-terraform/issues/669)) ([7e9e542](https://github.com/sethbacon/azure-pipelines-terraform/commit/7e9e54239e0eb4c308387684e35d17083f0c4fd4)), closes [#656](https://github.com/sethbacon/azure-pipelines-terraform/issues/656)
* escape Sentinel HCL newlines and terraform-docs arg parsing ([#666](https://github.com/sethbacon/azure-pipelines-terraform/issues/666)) ([731c4e9](https://github.com/sethbacon/azure-pipelines-terraform/commit/731c4e924ebd07da00ca06be5ea2342b2411731b)), closes [#648](https://github.com/sethbacon/azure-pipelines-terraform/issues/648) [#644](https://github.com/sethbacon/azure-pipelines-terraform/issues/644) [#661](https://github.com/sethbacon/azure-pipelines-terraform/issues/661)
* fail closed on cross-tenant OIDC hosts and harden auth error paths ([#673](https://github.com/sethbacon/azure-pipelines-terraform/issues/673)) ([2866778](https://github.com/sethbacon/azure-pipelines-terraform/commit/28667784b67547fbe3862a33c8d7bd625fd1970b)), closes [#647](https://github.com/sethbacon/azure-pipelines-terraform/issues/647)
* harden secret-file lifecycle, bound subprocess capture, secure mirror config ([#670](https://github.com/sethbacon/azure-pipelines-terraform/issues/670)) ([c89c19a](https://github.com/sethbacon/azure-pipelines-terraform/commit/c89c19aa5856a061d684601c1b764ddadabf125e))
* honor 429 Retry-After, bootstrap loc(), fix drift output-var casing ([#665](https://github.com/sethbacon/azure-pipelines-terraform/issues/665)) ([a1ee57c](https://github.com/sethbacon/azure-pipelines-terraform/commit/a1ee57cce80c19ad923786c08b65bc186c7c0b3e)), closes [#633](https://github.com/sethbacon/azure-pipelines-terraform/issues/633) [#637](https://github.com/sethbacon/azure-pipelines-terraform/issues/637) [#643](https://github.com/sethbacon/azure-pipelines-terraform/issues/643)
* invert KB HTML sanitization to a vetted allowlist sanitizer ([#672](https://github.com/sethbacon/azure-pipelines-terraform/issues/672)) ([64f0ace](https://github.com/sethbacon/azure-pipelines-terraform/commit/64f0acedaac0bced55fac26e930fe5d1be2b5e0e)), closes [#552](https://github.com/sethbacon/azure-pipelines-terraform/issues/552)


### Documentation

* fix OCI PAR secret handling, release-process drift, and stale audit docs ([#667](https://github.com/sethbacon/azure-pipelines-terraform/issues/667)) ([ce64257](https://github.com/sethbacon/azure-pipelines-terraform/commit/ce64257a6c5e9455a8837c94fb9f99fc88f8e182)), closes [#631](https://github.com/sethbacon/azure-pipelines-terraform/issues/631) [#640](https://github.com/sethbacon/azure-pipelines-terraform/issues/640) [#641](https://github.com/sethbacon/azure-pipelines-terraform/issues/641) [#642](https://github.com/sethbacon/azure-pipelines-terraform/issues/642) [#657](https://github.com/sethbacon/azure-pipelines-terraform/issues/657) [#658](https://github.com/sethbacon/azure-pipelines-terraform/issues/658) [#660](https://github.com/sethbacon/azure-pipelines-terraform/issues/660) [#663](https://github.com/sethbacon/azure-pipelines-terraform/issues/663)

## [1.10.4](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.3...v1.10.4) (2026-07-18)


### Bug Fixes

* honor user -out= in publishPlanSummary and order apply -json ([#626](https://github.com/sethbacon/azure-pipelines-terraform/issues/626)) ([97e4ef0](https://github.com/sethbacon/azure-pipelines-terraform/commit/97e4ef088b55027597487d29537f184ae8025651)), closes [#612](https://github.com/sethbacon/azure-pipelines-terraform/issues/612) [#613](https://github.com/sethbacon/azure-pipelines-terraform/issues/613)

## [1.10.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.2...v1.10.3) (2026-07-18)


### Bug Fixes

* apply Windows DACLs to sensitive temp files and clarify TLS-skip risk ([#621](https://github.com/sethbacon/azure-pipelines-terraform/issues/621)) ([d43efb9](https://github.com/sethbacon/azure-pipelines-terraform/commit/d43efb955addf6a069fb871e8032178e75670860))
* clear npm audit gate via task-lib refresh and adm-zip override ([#614](https://github.com/sethbacon/azure-pipelines-terraform/issues/614)) ([0189918](https://github.com/sethbacon/azure-pipelines-terraform/commit/0189918cb876e2dd9100138f027044c349699712))
* fail closed on withheld verification material and mask URL secrets ([#618](https://github.com/sethbacon/azure-pipelines-terraform/issues/618)) ([5b62229](https://github.com/sethbacon/azure-pipelines-terraform/commit/5b62229c3007b4a1e886e634cf2bbb73bc5ff488)), closes [#497](https://github.com/sethbacon/azure-pipelines-terraform/issues/497)
* harden ServiceNow KB pipeline against CSS-escape and sys_id injection ([#620](https://github.com/sethbacon/azure-pipelines-terraform/issues/620)) ([0f5371e](https://github.com/sethbacon/azure-pipelines-terraform/commit/0f5371ecee477d3f313188f135d8954c70e9d5b4))
* harden V5 auth-scheme validation and OCI PAR config handling ([#617](https://github.com/sethbacon/azure-pipelines-terraform/issues/617)) ([0c771bd](https://github.com/sethbacon/azure-pipelines-terraform/commit/0c771bd1b12c569df899462d7cbe3c5dfe68c3de))
* override adm-zip at the repo root to clear the full-tree audit ([#624](https://github.com/sethbacon/azure-pipelines-terraform/issues/624)) ([3b12420](https://github.com/sethbacon/azure-pipelines-terraform/commit/3b12420f08b64aee01975cd8059ff883633936c0))
* unify retry backoff and treat HTTP 429 as retryable ([#619](https://github.com/sethbacon/azure-pipelines-terraform/issues/619)) ([ca0873a](https://github.com/sethbacon/azure-pipelines-terraform/commit/ca0873ab4bbcbda1534bf53f877ea2262d262bc7))


### Documentation

* reconcile README, CLAUDE.md, notices, and marketplace listing ([#616](https://github.com/sethbacon/azure-pipelines-terraform/issues/616)) ([89b1c24](https://github.com/sethbacon/azure-pipelines-terraform/commit/89b1c24468940c18ce70853b0c176e4a6d792d7f)), closes [#601](https://github.com/sethbacon/azure-pipelines-terraform/issues/601) [#602](https://github.com/sethbacon/azure-pipelines-terraform/issues/602) [#603](https://github.com/sethbacon/azure-pipelines-terraform/issues/603) [#608](https://github.com/sethbacon/azure-pipelines-terraform/issues/608)

## [1.10.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.1...v1.10.2) (2026-07-17)


### Bug Fixes

* bump Minor for the 10 tasks changed in v1.10.1 ([#577](https://github.com/sethbacon/azure-pipelines-terraform/issues/577)) ([#579](https://github.com/sethbacon/azure-pipelines-terraform/issues/579)) ([449388d](https://github.com/sethbacon/azure-pipelines-terraform/commit/449388de8a4cf93ac15c9ebba7557fe3d010de9b))

## [1.10.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.10.0...v1.10.1) (2026-07-17)


### Bug Fixes

* remediate 2026-07-16 security-audit findings across tasks, CI, and docs ([#577](https://github.com/sethbacon/azure-pipelines-terraform/issues/577)) ([21685ed](https://github.com/sethbacon/azure-pipelines-terraform/commit/21685edec2b657adb285f495491b13dd94a21beb))

## [1.10.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.9.5...v1.10.0) (2026-07-16)


### Features

* structured destroy + state-inventory tab (Phase 5) ([#544](https://github.com/sethbacon/azure-pipelines-terraform/issues/544)) ([6c250e0](https://github.com/sethbacon/azure-pipelines-terraform/commit/6c250e0f209862e8de9ea5fb50d2892f58e56d7d))
* structured Terraform Plan & Apply build-results tabs ([#537](https://github.com/sethbacon/azure-pipelines-terraform/issues/537)) ([bdc129d](https://github.com/sethbacon/azure-pipelines-terraform/commit/bdc129daac346cb32544efe8ea52809470a09064))

## [1.9.5](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.9.4...v1.9.5) (2026-07-16)


### Bug Fixes

* proxy support, live-TLS regression tests, and callback failure gating for credential-bearing HTTP clients ([#530](https://github.com/sethbacon/azure-pipelines-terraform/issues/530)) ([2f45527](https://github.com/sethbacon/azure-pipelines-terraform/commit/2f45527f9ffea16153c54225ab52ded92e73147a))


### Documentation

* OCI WIF setup guide, V5 inputs/outputs reference, release-checklist and CONTRIBUTING corrections ([#531](https://github.com/sethbacon/azure-pipelines-terraform/issues/531)) ([32f42bf](https://github.com/sethbacon/azure-pipelines-terraform/commit/32f42bfa2f66849169c6ec1d11e151381d5b0637))


### Security

* fix Markdown2Html/PublishKbArticle XSS gaps and ServiceNow response validation (audit [#12](https://github.com/sethbacon/azure-pipelines-terraform/issues/12), [#13](https://github.com/sethbacon/azure-pipelines-terraform/issues/13)/[#446](https://github.com/sethbacon/azure-pipelines-terraform/issues/446), [#29](https://github.com/sethbacon/azure-pipelines-terraform/issues/29)/[#372](https://github.com/sethbacon/azure-pipelines-terraform/issues/372), [#19](https://github.com/sethbacon/azure-pipelines-terraform/issues/19)/[#396](https://github.com/sethbacon/azure-pipelines-terraform/issues/396)) ([#483](https://github.com/sethbacon/azure-pipelines-terraform/issues/483)) ([b3af23c](https://github.com/sethbacon/azure-pipelines-terraform/commit/b3af23c84aecdfbf5029232f24fd9ae033e501d6))
* harden PolicyCheck temp file handling ([#526](https://github.com/sethbacon/azure-pipelines-terraform/issues/526)) ([bdc3f1e](https://github.com/sethbacon/azure-pipelines-terraform/commit/bdc3f1ea4f22152c68541db204716fbf7eb84a22)), closes [#487](https://github.com/sethbacon/azure-pipelines-terraform/issues/487) [#503](https://github.com/sethbacon/azure-pipelines-terraform/issues/503) [#505](https://github.com/sethbacon/azure-pipelines-terraform/issues/505) [#510](https://github.com/sethbacon/azure-pipelines-terraform/issues/510)
* harden TerraformTaskV5 credential/output file handling and WIF endpoint validation ([#532](https://github.com/sethbacon/azure-pipelines-terraform/issues/532)) ([0351ef6](https://github.com/sethbacon/azure-pipelines-terraform/commit/0351ef6978a14b02489387b7142a47e02a12a1d8))
* KB/Markdown2Html sanitizer and ServiceNow client follow-ups from the [#483](https://github.com/sethbacon/azure-pipelines-terraform/issues/483) adversarial review ([#528](https://github.com/sethbacon/azure-pipelines-terraform/issues/528)) ([64e1e91](https://github.com/sethbacon/azure-pipelines-terraform/commit/64e1e914c50ba8ed0ffb98bedfdc53937d1f60cd))
* re-verify cached tools, add trust-root canary fixtures, and fail closed on missing agent temp dir ([#529](https://github.com/sethbacon/azure-pipelines-terraform/issues/529)) ([b24de2b](https://github.com/sethbacon/azure-pipelines-terraform/commit/b24de2b93203630166243d27fbae43ce7faf624a)), closes [#496](https://github.com/sethbacon/azure-pipelines-terraform/issues/496)

## [1.9.4](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.9.3...v1.9.4) (2026-07-14)


### Refactor

* add tasks.loc() to 4 remaining tasks ([#481](https://github.com/sethbacon/azure-pipelines-terraform/issues/481)) ([ab5acec](https://github.com/sethbacon/azure-pipelines-terraform/commit/ab5acec454ad7dc4fdc8756583051a64a16b7ac7))

## [1.9.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.9.2...v1.9.3) (2026-07-14)


### Bug Fixes

* add bounded retry to DriftReport callback and PublishKbArticle ServiceNow calls ([#465](https://github.com/sethbacon/azure-pipelines-terraform/issues/465)) ([50bbc02](https://github.com/sethbacon/azure-pipelines-terraform/commit/50bbc021021594ed636c02eb600e635a6de9bc6b))


### Documentation

* fix nonexistent task id TerraformTaskV5@5 in WIF/private-testing setup guides ([#474](https://github.com/sethbacon/azure-pipelines-terraform/issues/474)) ([0b05f1e](https://github.com/sethbacon/azure-pipelines-terraform/commit/0b05f1e59caa79e768ad54a05f27a0c43511289f))
* refresh CLAUDE.md, CONTRIBUTING.md, THIRD_PARTY_NOTICES.md, and bound the tfx-cli Dependabot ignore rule ([#477](https://github.com/sethbacon/azure-pipelines-terraform/issues/477)) ([4d77720](https://github.com/sethbacon/azure-pipelines-terraform/commit/4d777203ce7d432fcae74daba354ea93ce3460a0))


### Refactor

* dedup multiline-input parsing in TerraformTaskV5 ([#480](https://github.com/sethbacon/azure-pipelines-terraform/issues/480)) ([f612b5f](https://github.com/sethbacon/azure-pipelines-terraform/commit/f612b5f050cb05247f9e3947c62d52ff8c42fcbe))


### Security

* cap installer http-client.ts response body size at 10MB ([#472](https://github.com/sethbacon/azure-pipelines-terraform/issues/472)) ([2cb8012](https://github.com/sethbacon/azure-pipelines-terraform/commit/2cb8012769d95dcd167b10203e016cdbe06fc378))
* contain unredacted terraform output -json file ([#464](https://github.com/sethbacon/azure-pipelines-terraform/issues/464)) ([a2af457](https://github.com/sethbacon/azure-pipelines-terraform/commit/a2af4573e3c7e70f90acea931471982b9058922e))
* dedupe HTML/URI sanitizer into a shared, parity-checked module ([#470](https://github.com/sethbacon/azure-pipelines-terraform/issues/470)) ([4a8197a](https://github.com/sethbacon/azure-pipelines-terraform/commit/4a8197a978dfaea63b23c9a33528ac5a7569a87a))
* error-handling cleanup and TerraformTaskV5 proxy configuration parity ([#478](https://github.com/sethbacon/azure-pipelines-terraform/issues/478)) ([a70ccc9](https://github.com/sethbacon/azure-pipelines-terraform/commit/a70ccc91c81294c5c26d5811fa2c00b8fb2a98b3))
* escape mirrorUrl in generated HCL and guard listArticleAttachments query ([#476](https://github.com/sethbacon/azure-pipelines-terraform/issues/476)) ([4101e43](https://github.com/sethbacon/azure-pipelines-terraform/commit/4101e43cd1b18e9c0b8febf68a9f9d5e381ce5a7))
* mask derived secrets (OAuth clientSecret, Basic base64 header) and add isSecret to 4 token inputs ([#475](https://github.com/sethbacon/azure-pipelines-terraform/issues/475)) ([000680d](https://github.com/sethbacon/azure-pipelines-terraform/commit/000680d289c1133213a506604e0aad810bed3ee3))
* reject terragrunt binaryName and escape Sentinel policy names in generated HCL ([#473](https://github.com/sethbacon/azure-pipelines-terraform/issues/473)) ([be4f75c](https://github.com/sethbacon/azure-pipelines-terraform/commit/be4f75c83a189f725a479ca846633130658edfda))
* scope PublishKbArticle force input to only the content-loss heuristic ([#467](https://github.com/sethbacon/azure-pipelines-terraform/issues/467)) ([bf6dd5a](https://github.com/sethbacon/azure-pipelines-terraform/commit/bf6dd5aeeecfd5a33a943baff318bc547e0ec71e))

## [1.9.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.9.1...v1.9.2) (2026-07-12)


### Documentation

* **security:** clarify npm audit gate threshold + OSV weekly triage (c1/c2) ([#461](https://github.com/sethbacon/azure-pipelines-terraform/issues/461)) ([01c2d9d](https://github.com/sethbacon/azure-pipelines-terraform/commit/01c2d9d98061afccfc9f370dbaed4dfe46cbd2f1))


### Refactor

* decompose PublishKbArticle run() and track servicenow-http.ts ([#459](https://github.com/sethbacon/azure-pipelines-terraform/issues/459)) ([3f74356](https://github.com/sethbacon/azure-pipelines-terraform/commit/3f74356d7050b4e9ad3d3e41827bb84a56c58ee0)), closes [#397](https://github.com/sethbacon/azure-pipelines-terraform/issues/397)

## [1.9.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.9.0...v1.9.1) (2026-07-09)


### Bug Fixes

* publish KB via PATCH; drop dead /publish action ([#457](https://github.com/sethbacon/azure-pipelines-terraform/issues/457)) ([a52e600](https://github.com/sethbacon/azure-pipelines-terraform/commit/a52e6006e133b3dde265aa7bce743e39a61b95ea))

## [1.9.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.6...v1.9.0) (2026-07-08)


### Features

* auto-create new modules on private publish ([#455](https://github.com/sethbacon/azure-pipelines-terraform/issues/455)) ([1921252](https://github.com/sethbacon/azure-pipelines-terraform/commit/1921252969ab3d566a310eb425d1106c254b6629))

## [1.8.6](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.5...v1.8.6) (2026-07-07)


### Bug Fixes

* **PublishKbArticle:** resolve article id via sourceKey then KB*.json before create ([#454](https://github.com/sethbacon/azure-pipelines-terraform/issues/454)) ([3943032](https://github.com/sethbacon/azure-pipelines-terraform/commit/3943032b47c459e6d835226a8cb4d17f324649a4))
* remediate P0-P3 findings from the 5th re-audit (KB XSS, registry-URL leak, Sentinel fail-open, KB identity, CI coverage, hygiene) ([#452](https://github.com/sethbacon/azure-pipelines-terraform/issues/452)) ([3999dae](https://github.com/sethbacon/azure-pipelines-terraform/commit/3999daee7a3b0f6bc29fe534237edf07dc31bd4a))

## [1.8.5](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.4...v1.8.5) (2026-07-07)


### Bug Fixes

* guard terraform-docs configFile against empty-filePath-to-cwd ([#441](https://github.com/sethbacon/azure-pipelines-terraform/issues/441)) ([15537a2](https://github.com/sethbacon/azure-pipelines-terraform/commit/15537a283125985ea6e79a78d6d65ac5f3c873bb))
* remediate P0/P1 re-audit findings (mirror GPG, fail-closed latest, injection-guard tests) ([0307b4d](https://github.com/sethbacon/azure-pipelines-terraform/commit/0307b4dddd487f3ff5795e057714d1a90ebbe43a))
* remediate P2 re-audit findings (bool-input parity, resilience residuals, mirror tests, release-safety) ([#444](https://github.com/sethbacon/azure-pipelines-terraform/issues/444)) ([5164eac](https://github.com/sethbacon/azure-pipelines-terraform/commit/5164eacb4610406c9a6f7b3484bf67de8d3b049f))
* remediate P3 re-audit findings (LOW/MED hardening, CI, manifests, docs) ([#445](https://github.com/sethbacon/azure-pipelines-terraform/issues/445)) ([f01ae99](https://github.com/sethbacon/azure-pipelines-terraform/commit/f01ae9969ba1dea86d07fcf594c213d2c3ce4c66))

## [1.8.4](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.3...v1.8.4) (2026-07-06)


### Bug Fixes

* remediate P0/P1 security audit findings ([#384](https://github.com/sethbacon/azure-pipelines-terraform/issues/384)-[#389](https://github.com/sethbacon/azure-pipelines-terraform/issues/389)) ([ca658e1](https://github.com/sethbacon/azure-pipelines-terraform/commit/ca658e1ad8eab12a0526391623d5605d1ace6989))
* remediate P2 security audit findings ([#390](https://github.com/sethbacon/azure-pipelines-terraform/issues/390)-[#393](https://github.com/sethbacon/azure-pipelines-terraform/issues/393)) ([855e953](https://github.com/sethbacon/azure-pipelines-terraform/commit/855e9531939da93df872fd7b4bb031517a2c0dfc))
* remediate P3 security audit residuals ([#394](https://github.com/sethbacon/azure-pipelines-terraform/issues/394)/[#395](https://github.com/sethbacon/azure-pipelines-terraform/issues/395)/[#398](https://github.com/sethbacon/azure-pipelines-terraform/issues/398)/[#399](https://github.com/sethbacon/azure-pipelines-terraform/issues/399)) ([0025455](https://github.com/sethbacon/azure-pipelines-terraform/commit/00254552f17c4deef6bcd1cca9d9d79a0f5b77df))

## [1.8.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.2...v1.8.3) (2026-07-06)


### Documentation

* document the Entra token argv-exposure risk and its 10-minute lifetime mitigation ([#346](https://github.com/sethbacon/azure-pipelines-terraform/issues/346)) ([96b68b3](https://github.com/sethbacon/azure-pipelines-terraform/commit/96b68b393ed74020eb9b58ea90a6ab87c27c261c))
* fix stale claim that npm ci --ignore-scripts wasn't ported here ([#349](https://github.com/sethbacon/azure-pipelines-terraform/issues/349)) ([f4fd517](https://github.com/sethbacon/azure-pipelines-terraform/commit/f4fd517616d80e2dafa8f250c4e8a2e2ca14587d))


### Security

* backport azure-pipelines-packer's http-client.ts hardening ([#350](https://github.com/sethbacon/azure-pipelines-terraform/issues/350)) ([0e93cc2](https://github.com/sethbacon/azure-pipelines-terraform/commit/0e93cc29457244cdc43ca67096929f3403470835))
* OIDC token lifecycle and process termination hardening ([#362](https://github.com/sethbacon/azure-pipelines-terraform/issues/362)) ([80fcb64](https://github.com/sethbacon/azure-pipelines-terraform/commit/80fcb643b2944fc3874cc7f58dc7d2affac598ac))
* port release-pipeline hardening from azure-pipelines-packer's second security audit ([#348](https://github.com/sethbacon/azure-pipelines-terraform/issues/348)) ([1e3c5df](https://github.com/sethbacon/azure-pipelines-terraform/commit/1e3c5df83bead8dd2849db653623221e86708175))
* remediate 2026-07-04 security audit findings ([#383](https://github.com/sethbacon/azure-pipelines-terraform/issues/383)) ([b74d866](https://github.com/sethbacon/azure-pipelines-terraform/commit/b74d866ca5a2fc2e3795e330e59d3f89cdb07020))
* TerraformInstallerV1 supply-chain hardening ([#361](https://github.com/sethbacon/azure-pipelines-terraform/issues/361)) ([16f2f34](https://github.com/sethbacon/azure-pipelines-terraform/commit/16f2f34d296bf0a96e0787d5268efeb8a04ca9c3))
* TerraformTaskV5 secret-hygiene hardening ([#360](https://github.com/sethbacon/azure-pipelines-terraform/issues/360)) ([20b8f90](https://github.com/sethbacon/azure-pipelines-terraform/commit/20b8f901adaa02c6bae995555f0123d09b0b299c))

## [1.8.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.1...v1.8.2) (2026-07-03)


### Bug Fixes

* remove unused os import from GCP init test fixtures ([#344](https://github.com/sethbacon/azure-pipelines-terraform/issues/344)) ([9a3d80f](https://github.com/sethbacon/azure-pipelines-terraform/commit/9a3d80f5c3660e5b96f3de2b0a2c2f5e8dd4a855))

## [1.8.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.8.0...v1.8.1) (2026-07-03)


### Bug Fixes

* support cross-cloud Terraform state backend credentials on plan/apply/etc. ([#342](https://github.com/sethbacon/azure-pipelines-terraform/issues/342)) ([c73dec0](https://github.com/sethbacon/azure-pipelines-terraform/commit/c73dec0291b72f1c6ea3cab1fbfe4601e43fad36))

## [1.8.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.7.1...v1.8.0) (2026-07-01)


### Features

* add Markdown2Html task ([#337](https://github.com/sethbacon/azure-pipelines-terraform/issues/337)) ([1d6a4b8](https://github.com/sethbacon/azure-pipelines-terraform/commit/1d6a4b8ae45d1dfb28b552f372a79c1e6c51866c))
* add PublishKbArticle task ([#339](https://github.com/sethbacon/azure-pipelines-terraform/issues/339)) ([51d0863](https://github.com/sethbacon/azure-pipelines-terraform/commit/51d08633cf7f8dd441992e5568b2159c7dd1c926))


### Documentation

* document Markdown2Html and PublishKbArticle ([#340](https://github.com/sethbacon/azure-pipelines-terraform/issues/340)) ([3a6d764](https://github.com/sethbacon/azure-pipelines-terraform/commit/3a6d7645fcd8d451f65377ed16358054aa6cdd94))

## [1.7.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.7.0...v1.7.1) (2026-07-01)


### Bug Fixes

* **deps:** patch js-yaml ReDoS + bump nyc to 18 ([#335](https://github.com/sethbacon/azure-pipelines-terraform/issues/335)) ([ce4ee92](https://github.com/sethbacon/azure-pipelines-terraform/commit/ce4ee928a2d14b4ff9bfde7cd3d09ae904b49db9))

## [1.7.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.4...v1.7.0) (2026-07-01)


### Features

* add terraform-docs installer and docs tasks ([#332](https://github.com/sethbacon/azure-pipelines-terraform/issues/332)) ([4cddcec](https://github.com/sethbacon/azure-pipelines-terraform/commit/4cddcec02bca2bac620edc99cedcec16707face5))

## [1.6.4](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.3...v1.6.4) (2026-06-30)


### Bug Fixes

* allow PATH in installer restricted allowlists ([#330](https://github.com/sethbacon/azure-pipelines-terraform/issues/330)) ([672a086](https://github.com/sethbacon/azure-pipelines-terraform/commit/672a086a2aee56627fe0181f4c84f749288ef79a)), closes [#329](https://github.com/sethbacon/azure-pipelines-terraform/issues/329)

## [1.6.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.2...v1.6.3) (2026-06-30)


### Bug Fixes

* prefer installer terraformLocation over PATH lookup ([#321](https://github.com/sethbacon/azure-pipelines-terraform/issues/321)) ([90c2e3d](https://github.com/sethbacon/azure-pipelines-terraform/commit/90c2e3d1eccf1c23cdefb74624cc47ff30447031))
* prepend installed Terraform/OpenTofu dir to PATH ([#320](https://github.com/sethbacon/azure-pipelines-terraform/issues/320)) ([b6e2650](https://github.com/sethbacon/azure-pipelines-terraform/commit/b6e2650dc3dfe1ad6670b8e0280dac806a0c871d)), closes [#319](https://github.com/sethbacon/azure-pipelines-terraform/issues/319)


### Documentation

* document accepted az login argv credential exposure ([#327](https://github.com/sethbacon/azure-pipelines-terraform/issues/327)) ([2a62b7e](https://github.com/sethbacon/azure-pipelines-terraform/commit/2a62b7efb8a33ae6e23af08a88bfb5d27a983dc6)), closes [#288](https://github.com/sethbacon/azure-pipelines-terraform/issues/288)
* document why the two HTTP client families stay separate ([#324](https://github.com/sethbacon/azure-pipelines-terraform/issues/324)) ([c6bd90d](https://github.com/sethbacon/azure-pipelines-terraform/commit/c6bd90d5046f4ad7998d9fd9f94d2e82b4d7c5b8)), closes [#301](https://github.com/sethbacon/azure-pipelines-terraform/issues/301)


### Refactor

* single chokepoint for commandOptions input ([#328](https://github.com/sethbacon/azure-pipelines-terraform/issues/328)) ([98b56eb](https://github.com/sethbacon/azure-pipelines-terraform/commit/98b56eb0d3e87bb85038b4182cec4a3c76ac07ff)), closes [#302](https://github.com/sethbacon/azure-pipelines-terraform/issues/302)


### Security

* opt-in host allowlist for registry download_url ([#322](https://github.com/sethbacon/azure-pipelines-terraform/issues/322)) ([22cd89b](https://github.com/sethbacon/azure-pipelines-terraform/commit/22cd89bcb8b02f33f190cafe8eee89ae8342881a))
* support user-assigned MSI client ID ([#326](https://github.com/sethbacon/azure-pipelines-terraform/issues/326)) ([855a8c3](https://github.com/sethbacon/azure-pipelines-terraform/commit/855a8c3ad7d95d26b0bb8fe7edc76ae2c93a6e6b)), closes [#289](https://github.com/sethbacon/azure-pipelines-terraform/issues/289)
* validate OCI WIF tenancy OCID and region ([#325](https://github.com/sethbacon/azure-pipelines-terraform/issues/325)) ([3164521](https://github.com/sethbacon/azure-pipelines-terraform/commit/316452172d5576810296fd54608afe5779a8c758)), closes [#296](https://github.com/sethbacon/azure-pipelines-terraform/issues/296)

## [1.6.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.1...v1.6.2) (2026-06-29)


### Bug Fixes

* crop marketplace screenshots ([ef568ad](https://github.com/sethbacon/azure-pipelines-terraform/commit/ef568ad9676e5d0797be3c4dfdd6dc58b7cb5e5c))
* **deps:** pin js-yaml &gt;=4.2.0 to resolve DoS advisory (4 tasks) ([57f1b4a](https://github.com/sethbacon/azure-pipelines-terraform/commit/57f1b4a3657ef23fdd94b69f3e2eb7bef2a2110a))


### Documentation

* document accepted security residuals ([#315](https://github.com/sethbacon/azure-pipelines-terraform/issues/315)) ([58d2409](https://github.com/sethbacon/azure-pipelines-terraform/commit/58d240979ca0258b26ad3756b3607790b55b4838)), closes [#286](https://github.com/sethbacon/azure-pipelines-terraform/issues/286) [#290](https://github.com/sethbacon/azure-pipelines-terraform/issues/290) [#292](https://github.com/sethbacon/azure-pipelines-terraform/issues/292) [#293](https://github.com/sethbacon/azure-pipelines-terraform/issues/293) [#294](https://github.com/sethbacon/azure-pipelines-terraform/issues/294) [#300](https://github.com/sethbacon/azure-pipelines-terraform/issues/300) [#304](https://github.com/sethbacon/azure-pipelines-terraform/issues/304) [#311](https://github.com/sethbacon/azure-pipelines-terraform/issues/311) [#312](https://github.com/sethbacon/azure-pipelines-terraform/issues/312) [#313](https://github.com/sethbacon/azure-pipelines-terraform/issues/313) [#314](https://github.com/sethbacon/azure-pipelines-terraform/issues/314)


### Security

* fail-secure drift callback TLS verify ([#318](https://github.com/sethbacon/azure-pipelines-terraform/issues/318)) ([76351d0](https://github.com/sethbacon/azure-pipelines-terraform/commit/76351d00d9b0b94e8b60a2e2bfb8e78c27b88024)), closes [#307](https://github.com/sethbacon/azure-pipelines-terraform/issues/307)
* harden OCI WIF temp-dir and cleanup ([#316](https://github.com/sethbacon/azure-pipelines-terraform/issues/316)) ([2c08708](https://github.com/sethbacon/azure-pipelines-terraform/commit/2c0870897503eb10a4a589f757a629848a273148))
* pin per-task deps with npm ci in build ([#284](https://github.com/sethbacon/azure-pipelines-terraform/issues/284)) ([1b5e6ff](https://github.com/sethbacon/azure-pipelines-terraform/commit/1b5e6ffab633915a62506d47f99380e59fe39ed5)), closes [#239](https://github.com/sethbacon/azure-pipelines-terraform/issues/239)
* validate sentinel import name ([#317](https://github.com/sethbacon/azure-pipelines-terraform/issues/317)) ([42e8ae9](https://github.com/sethbacon/azure-pipelines-terraform/commit/42e8ae9549f0566df86edc235cd68f60bc56f7e9))

## [1.6.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.6.0...v1.6.1) (2026-06-28)


### Bug Fixes

* refresh marketplace screenshots for all task forms ([15e0275](https://github.com/sethbacon/azure-pipelines-terraform/commit/15e02757088c9b3ee715625096066fff076199c2))

## [1.6.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.5.1...v1.6.0) (2026-06-28)


### Features

* SARIF 2.1.0 output for PolicyCheck and DriftReport ([#246](https://github.com/sethbacon/azure-pipelines-terraform/issues/246)) ([b5c5c83](https://github.com/sethbacon/azure-pipelines-terraform/commit/b5c5c8366eaa3ee7b567255d68c9a32abeaac0bc)), closes [#244](https://github.com/sethbacon/azure-pipelines-terraform/issues/244)


### Bug Fixes

* add network timeouts and bounded poll loops ([#256](https://github.com/sethbacon/azure-pipelines-terraform/issues/256)) ([a3b407e](https://github.com/sethbacon/azure-pipelines-terraform/commit/a3b407e0e67130e9ce9795253cade711ee83c439)), closes [#236](https://github.com/sethbacon/azure-pipelines-terraform/issues/236)
* bound V5 secure-file download with a timeout ([f889517](https://github.com/sethbacon/azure-pipelines-terraform/commit/f8895175d4d6748cc6b7255fec40d04af571d6ca)), closes [#273](https://github.com/sethbacon/azure-pipelines-terraform/issues/273)
* drop release-please issues:write request ([#262](https://github.com/sethbacon/azure-pipelines-terraform/issues/262)) ([e2c2b45](https://github.com/sethbacon/azure-pipelines-terraform/commit/e2c2b450d34157f18bad31cfb96476f15b92c145))
* grant release-please issues:write for labels ([#261](https://github.com/sethbacon/azure-pipelines-terraform/issues/261)) ([3279945](https://github.com/sethbacon/azure-pipelines-terraform/commit/32799459ee57396f04060d73dd1fd7cd3851a66f))
* show requireChecksum for the registry source ([1a11b08](https://github.com/sethbacon/azure-pipelines-terraform/commit/1a11b0831b907ad4f1624447fe67b87566db0752)), closes [#274](https://github.com/sethbacon/azure-pipelines-terraform/issues/274)


### Dependencies

* patch serialize-javascript and js-yaml ([#260](https://github.com/sethbacon/azure-pipelines-terraform/issues/260)) ([8d76bb7](https://github.com/sethbacon/azure-pipelines-terraform/commit/8d76bb7e194443de90b9fcfaf04eb92246aab583))


### Documentation

* fix documentation drift ([#254](https://github.com/sethbacon/azure-pipelines-terraform/issues/254)) ([52a4549](https://github.com/sethbacon/azure-pipelines-terraform/commit/52a4549fd2bd3e7649fde7f49c79e3d0c028f25c)), closes [#240](https://github.com/sethbacon/azure-pipelines-terraform/issues/240)


### Refactor

* enforce installer shared-module parity ([be0e333](https://github.com/sethbacon/azure-pipelines-terraform/commit/be0e3333fb0f9eec185fb0f25af5acd8bfbad550)), closes [#238](https://github.com/sethbacon/azure-pipelines-terraform/issues/238)
* unify credential-bearing HTTPS client ([9fcef2b](https://github.com/sethbacon/azure-pipelines-terraform/commit/9fcef2baeebbb10450b027140b8da65553bd8bb6)), closes [#271](https://github.com/sethbacon/azure-pipelines-terraform/issues/271) [#272](https://github.com/sethbacon/azure-pipelines-terraform/issues/272)


### Security

* add task.json restrictions to all tasks ([#245](https://github.com/sethbacon/azure-pipelines-terraform/issues/245)) ([f228362](https://github.com/sethbacon/azure-pipelines-terraform/commit/f22836224b798545c3c3cb8a1bb3320b8f416919)), closes [#235](https://github.com/sethbacon/azure-pipelines-terraform/issues/235)
* anchor OpenTofu cosign cert identity ([#251](https://github.com/sethbacon/azure-pipelines-terraform/issues/251)) ([199337e](https://github.com/sethbacon/azure-pipelines-terraform/commit/199337e001832ec7effc18c935282038e62e15cf)), closes [#233](https://github.com/sethbacon/azure-pipelines-terraform/issues/233)
* harden PolicyCheck git policy source ([#275](https://github.com/sethbacon/azure-pipelines-terraform/issues/275)) ([611dbed](https://github.com/sethbacon/azure-pipelines-terraform/commit/611dbed7e8c78300854f6c6f6af771f95f33496b)), closes [#263](https://github.com/sethbacon/azure-pipelines-terraform/issues/263) [#264](https://github.com/sethbacon/azure-pipelines-terraform/issues/264) [#265](https://github.com/sethbacon/azure-pipelines-terraform/issues/265) [#266](https://github.com/sethbacon/azure-pipelines-terraform/issues/266)
* harden registry download path ([d37478d](https://github.com/sethbacon/azure-pipelines-terraform/commit/d37478dead92037e94ec5c458e80598e7e1bef3b)), closes [#234](https://github.com/sethbacon/azure-pipelines-terraform/issues/234)
* mask secrets + harden transport in publish/drift ([#250](https://github.com/sethbacon/azure-pipelines-terraform/issues/250)) ([221c669](https://github.com/sethbacon/azure-pipelines-terraform/commit/221c669edcf03630eac1f97d0b1c2e279ce80a8f)), closes [#232](https://github.com/sethbacon/azure-pipelines-terraform/issues/232)
* validate OCI WIF identity domain URL ([#249](https://github.com/sethbacon/azure-pipelines-terraform/issues/249)) ([a2f2b9e](https://github.com/sethbacon/azure-pipelines-terraform/commit/a2f2b9e68a71b50951d57996a1515e41274fe2ff)), closes [#231](https://github.com/sethbacon/azure-pipelines-terraform/issues/231)

## [1.5.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.5.0...v1.5.1) (2026-06-24)


### Bug Fixes

* prevent publishPlanResults attachment race ([#229](https://github.com/sethbacon/azure-pipelines-terraform/issues/229)) ([4f54662](https://github.com/sethbacon/azure-pipelines-terraform/commit/4f5466271554f4fd1b26135028e81c664cb52f2c))

## [1.5.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.3...v1.5.0) (2026-06-22)


### Features

* require Node 24 agent runtime, bump deps ([#225](https://github.com/sethbacon/azure-pipelines-terraform/issues/225)) ([5bc2bf7](https://github.com/sethbacon/azure-pipelines-terraform/commit/5bc2bf743751419eadf910f3f18f8deb15624817))


### Documentation

* reflect Node24-only execution floor ([#227](https://github.com/sethbacon/azure-pipelines-terraform/issues/227)) ([a64eb40](https://github.com/sethbacon/azure-pipelines-terraform/commit/a64eb4004fc6fc1125377f379465d54cfa6dd848))


### Security

* pin tfx-cli 0.23.2, overrides + drop glob-exec ([#228](https://github.com/sethbacon/azure-pipelines-terraform/issues/228)) ([7fa1f31](https://github.com/sethbacon/azure-pipelines-terraform/commit/7fa1f316f9a6f8e7132a3dd20eb0072501ca71e0))

## [1.4.3](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.2...v1.4.3) (2026-06-22)


### Bug Fixes

* track ProviderMirror in version check and bump it ([#223](https://github.com/sethbacon/azure-pipelines-terraform/issues/223)) ([6a1bd51](https://github.com/sethbacon/azure-pipelines-terraform/commit/6a1bd510d77b34154b63e9cb0042aa80755d8430))

## [1.4.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.1...v1.4.2) (2026-06-22)


### Bug Fixes

* bump task versions to refresh ADO task cache ([#221](https://github.com/sethbacon/azure-pipelines-terraform/issues/221)) ([919f5a1](https://github.com/sethbacon/azure-pipelines-terraform/commit/919f5a19fb13ac99debcef25151ae7a8d8882ce5))

## [1.4.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.4.0...v1.4.1) (2026-06-21)


### Bug Fixes

* **deps:** bump @babel/core and js-yaml, scope dev uuid override ([#219](https://github.com/sethbacon/azure-pipelines-terraform/issues/219)) ([65cdd44](https://github.com/sethbacon/azure-pipelines-terraform/commit/65cdd446cd57c7a5b40ce1afda593211b3613087))

## [1.4.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.3.0...v1.4.0) (2026-06-20)


### Features

* add TerraformDriftReport task sharing the drift contract ([#217](https://github.com/sethbacon/azure-pipelines-terraform/issues/217)) ([c00e59a](https://github.com/sethbacon/azure-pipelines-terraform/commit/c00e59a66d1fb41402776d3d8fbae5992e1a49c6))


### Documentation

* resolve initiative-6 drifted rule; point to the GitHub twin ([#213](https://github.com/sethbacon/azure-pipelines-terraform/issues/213)) ([e719011](https://github.com/sethbacon/azure-pipelines-terraform/commit/e71901181c83cb435e31f3878f2957391d4e0cd0))


### Security

* bump undici to ^6.27.0 in TerraformInstallerV1 (GHSA-p88m-4jfj-68fv) ([#215](https://github.com/sethbacon/azure-pipelines-terraform/issues/215)) ([616d488](https://github.com/sethbacon/azure-pipelines-terraform/commit/616d488bbc60b9be74808144fa023d7c78b7ca13))

## [1.3.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.2.0...v1.3.0) (2026-06-12)


### Features

* add policy agent installer and policy check tasks ([#208](https://github.com/sethbacon/azure-pipelines-terraform/issues/208)) ([cca3774](https://github.com/sethbacon/azure-pipelines-terraform/commit/cca3774eb8a6aeac45e1faba08df8eba36908c76))

## [1.2.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.1.2...v1.2.0) (2026-05-31)


### Features

* add module publish task (HCP + private) ([#205](https://github.com/sethbacon/azure-pipelines-terraform/issues/205)) ([a2df988](https://github.com/sethbacon/azure-pipelines-terraform/commit/a2df988bbc381b71d6380632600399fb6fb2104e))

## [1.1.2](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.1.1...v1.1.2) (2026-05-29)


### Documentation

* add YAML examples reference page ([#203](https://github.com/sethbacon/azure-pipelines-terraform/issues/203)) ([f2a4e9d](https://github.com/sethbacon/azure-pipelines-terraform/commit/f2a4e9da8acfcb33c104975e0e518ef231a9bce5))

## [1.1.1](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.1.0...v1.1.1) (2026-05-28)


### Bug Fixes

* unique provider mirror task id and command arg quoting ([#201](https://github.com/sethbacon/azure-pipelines-terraform/issues/201)) ([b214bd2](https://github.com/sethbacon/azure-pipelines-terraform/commit/b214bd2c1232f4b28152ee754c494c48f38b7938))

## [1.1.0](https://github.com/sethbacon/azure-pipelines-terraform/compare/v1.0.12...v1.1.0) (2026-05-28)


### Features

* add provider mirror configuration task ([#199](https://github.com/sethbacon/azure-pipelines-terraform/issues/199)) ([dacfc9c](https://github.com/sethbacon/azure-pipelines-terraform/commit/dacfc9c288f7e0f4fd786226699e6d8fa8a9f959))

## [1.0.12] — 2026-05-22

### Fixed

- **Guard null credentials and empty GPG signatures across all provider handlers** (closes #189–#195):
  - Azure handler (#189): throw on null `SystemVssConnection` AccessToken in OIDC token refresh path instead of silently passing `null` downstream
  - OCI handler (#190): validate `privateKey` before passing to `normalizePem`; throw a clear error when it is missing from the service connection
  - GCP handler (#191): validate all three credential fields (`Issuer`, `Audience`, `PrivateKey`) before writing the JSON credentials file; error message names which fields are missing
  - `id-token-generator` (#192): validate `AccessToken` before building the `Bearer` header; surfacing an actionable error when `SystemVssConnection` is unavailable prevents opaque HTTP 401 failures across all WIF providers
  - `gpg-verifier` (#193): guard `result.signatures.length > 0` before destructuring to avoid a `TypeError` on malformed or empty `.sig` files
  - AWS handler (#194): replace misleading `!` non-null assertions with `?? ''` on `required=false` credential parameters
  - Azure handler (#195): `tenantId` in `runAzLogin` changed to `required=true`; `ARM_TENANT_ID` env var set with `?? ''` to remove false type assertion

- **Upgrade to Node 24 LTS**: Node 20 reached EOL April 2026. All CI workflows, `package.json` engine constraints, and ADO `task.json` execution targets updated to Node 24 (`Node24` added alongside `Node20_1` for backward-compatible agent fallback).

- **GitHub Actions upgrades**: `actions/setup-node` v5→v6.4.0, `sigstore/cosign-installer` v3→v4.1.2, `softprops/action-gh-release` v2→v3.0.0 (native Node 24), `actions/github-script` v7→v9.0.0, `github/codeql-action` v3→v4.36.0, `actions/upload-artifact` v7.0.0→v7.0.1.

- **Bump task Minor versions for ADO cache invalidation**: TerraformTaskV5 `5.261→5.262`, TerraformInstallerV1 `1.220→1.221`.

- **Fix cosign v4 bundle format**: `sigstore/cosign-installer` v4 dropped `--output-signature`/`--output-certificate` in favour of `--bundle`. Release workflow updated to produce a single `.vsix.bundle` artifact instead of separate `.sig` and `.pem` files.

## [1.0.11] — 2026-05-16

### Fixed

- **Bump TerraformInstallerV1 Minor to 220 for ADO cache invalidation**: the v1.0.10 fix to the registry binary download was not picked up by ADO agents because the task Minor version was not incremented. TerraformInstaller is now at `1.220.0`.

## [1.0.10] — 2026-05-16

### Fixed

- **TerraformInstallerV1 registry download no longer fails when registry returns empty sha256**: when `downloadSource: registry` is used, the installer calls the per-platform endpoint which may return an empty `sha256` field if the registry already verified the binary server-side (`sha256_verified: true`). An empty string is falsy in JavaScript, causing a spurious "missing sha256" error. The guard now only requires `download_url`; local SHA256 verification is performed when the field is non-empty and skipped (with a debug log) when it is empty.

## [1.0.9] — 2026-05-15

### Fixed

- **Bump task Minor versions to invalidate ADO distributed task cache**: Azure DevOps caches tasks by Major.Minor and only refreshes when Minor increments. The v1.0.8 fix was not served to agents because only Patch was bumped. TerraformTask now at `5.261.0`, TerraformInstaller at `1.219.0`.

## [1.0.8] — 2026-05-15

### Fixed

- **`test` command no longer requires a service connection**: previously, running `terraform test` with any provider would fail with `Input required: environmentServiceNameAWS` (or the equivalent for other providers) even when the tests didn't need cloud credentials. The service connection is now optional for the `test` command — unit/validation tests work without one, while integration tests that provision real resources can still provide a service connection and the task will configure provider auth automatically.

## [1.0.7] — 2026-05-12

### Fixed

- Remove `task.loc.json` from `TerraformInstallerV1`: the file had `"Minor": "217"` while `task.json` had `"Minor": "218"`, causing ADO to register the installer task as version `1.217.0` instead of `1.218.0`. This was the root cause of the "No task definition found" error in pipelines referencing the installer task. The file is unused (this extension does not use the ADO localization pipeline).

## [1.0.6] — 2026-05-12

### Fixed

- Reverted task ID changes from v1.0.5: the Visual Studio Marketplace `PackageValidationStep` enforces that task GUIDs cannot change across extension versions. Task IDs restored to originals (`310afe61-...` and `981E87CD-...`).
- No functional changes from v1.0.4.

## [1.0.5] — 2026-05-12 _(failed publish — do not use)_

- Attempted to change task GUIDs (`PipelineTerraformInstaller`, `PipelineTerraformTask`) to bypass an Azure DevOps org-level task catalog cache issue. Blocked by Marketplace `PackageValidationStep` validation; never successfully published.

## [1.0.4] — 2026-05-11

### Fixed

- Bump `postcss` to 8.5.14 (CVE-2026-41305, medium, dev dep — XSS in CSS stringify output)
- Bump `fast-uri` to 3.1.2 (CVE-2026-6322, high, dev dep — host confusion via percent-encoded authority)
- Bump `uuid` to 13.0.2 via `overrides` (CVE-2026-41907, medium, nested in tfx-cli — missing buffer bounds check)
- Resolve CodeQL `incomplete-url-substring-sanitization` warning in installer test by using exact hostname comparison

## [1.0.3] — 2026-05-11

### Fixed

- Extension contribution `name` paths were missing versioned subdirectory (`TerraformInstallerV1`, `TerraformTaskV5`); ADO could not locate `task.json` to register task packages, causing `No task definition found` errors in pipelines
- Replace `uuid` dependency with Node.js built-in `crypto.randomUUID()`; uuid v14 (ESM-only) broke CJS task runner; eliminates the dependency entirely from both tasks
- Update `fast-uri` to 3.1.2 in TerraformTaskV5 (dev dep, GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc)

## [1.0.2] — 2026-05-11

### Fixed

- Task packages (`PipelineTerraformInstaller@1`, `PipelineTerraformTask@5`) failed to register in ADO distributed task service after v1.0.1 install; re-publishing forces task re-registration

## [1.0.1] — 2026-04-17

### Fixed

- Installer `requireGpgSignature` visibleRule mixed `&&` and `||` operators, which VS Marketplace validation rejects; replaced with `binary = terraform && downloadSource != registry`

## [1.0.0] — 2026-04-17

### Added

- **P6.1 · OpenTofu installer support**: new `binary` input on TerraformInstaller (`terraform` | `tofu`); resolves latest version from GitHub releases API; downloads from `github.com/opentofu/opentofu/releases`; cosign signature verification of SHA256SUMS (optional, controlled by `requireCosignVerification` input); tool cache separated by binary name
- **P6.2 · OCI Workload Identity Federation**: OIDC-based authentication for OCI provider using RFC 8693 token exchange with OCI Identity Domains; generates ephemeral RSA-2048 key pair, exchanges Azure DevOps OIDC JWT for OCI User Principal Session Token (UPST), writes synthetic OCI config for SecurityToken auth mode; new task inputs: `environmentAuthSchemeOCI`, `ociWifTenancyOcid`, `ociWifRegion`, `ociWifIdentityDomainUrl`, `ociWifClientId`

### Changed

- **P6.0 · Codebase cleanup**: freshened Terraform fallback version to 1.14.8 and OpenTofu to 1.11.6; shared `RESOURCE_ADDRESS_RE` regex across plan/apply/destroy; removed dynamic `require()` in favor of static imports; upgraded React 16 → 18 with `createRoot` API; replaced OCI PEM string-replace chain with proper `normalizePem()` function; DRY'd `commandOptions` handling with shared `buildCommandArgs` pipeline

**193 tests passing** (158 TerraformTaskV5 + 15 TerraformInstallerV1 + 20 Tab/Jest)

## [0.9.0] — 2026-04-17

### Added

- **P5.3 · Actionlint**: GitHub Actions workflow files are now linted by `actionlint` on every CI run
- **P5.4 · CodeQL**: new TypeScript static analysis workflow runs on PRs and weekly schedule
- **P5.5 · Changelog guard**: release pipeline verifies `CHANGELOG.md` has an entry matching the tag version
- **P5.6 · Draft-first release**: release pipeline creates a draft GitHub release with `.vsix` before Marketplace publish; Marketplace publish requires manual approval via `marketplace` environment; release is undrafted on success
- **P5.7 · SBOM + cosign signing**: CycloneDX SBOMs generated for V5 and Installer V1 production deps; `.vsix` signed with cosign keyless (OIDC-backed); SBOM, signature, and certificate attached to GitHub releases

### Changed

- **P5.2 · Audit level lowered**: `npm audit` threshold lowered from `high` to `moderate` for earlier advisory detection
- **P5.1 · Cross-platform CI**: V5 and Installer V1 tests now run on both `ubuntu-latest` and `windows-latest`

### Test coverage

- **P4.1 · Tab unit tests**: 20 Jest tests for `ansiToHtml` (edge cases, performance, realistic terraform output)
- **P4.2 · Environment variable tests**: tracking, re-registration, clear-all cycle
- **P4.5 · Emergency cleanup test**: verifies `clearTrackedVariables()` removes env vars
- **P4.6 · Unknown provider test**: `ParentCommandHandler` rejects invalid provider
- **P4.7 · Coverage reporting**: nyc integration with 75/70/75 thresholds (stmts/branches/functions)
- **P4.8 · Lint extends to Tests/**: ESLint now covers `Tests/` directory with relaxed rules

**186 tests passing** (154 TerraformTaskV5 + 12 TerraformInstallerV1 + 20 Tab/Jest)

## [0.8.0] — 2026-04-17

### Security

- **P3.1 · Strict GPG verification**: new `requireGpgSignature` boolean input on TerraformInstaller (default `true` for HashiCorp source). When enabled, missing `.sig` files are a hard failure instead of a warning
- **P3.3 · Fail-closed auth scheme validation**: AWS and GCP handlers now validate `environmentAuthSchemeAWS`/`environmentAuthSchemeGCP` against `["ServiceConnection", "WorkloadIdentityFederation"]` and throw on unknown values — matches the existing AzureRM strict pattern
- **P3.4 · Secure temp file writes**: new shared `writeSecretFile()` helper (`secure-temp.ts`) writes credential files with `mode: 0o600` and verifies permissions; Windows ACL fallback. Used by AWS, GCP, and OCI OIDC token/key file writes
- **P3.7 · Stricter provider detection**: `warnIfMultipleProviders()` now uses anchored regex patterns (`provider[.*/aws]`) instead of substring `.includes()`, eliminating false positives from modules named like `my-aws-helper`

### Added

- **P3.2 · Plan tab hardening**: `ansiToHtml()` rewritten as a state machine that tracks open `<span>` tags to guarantee balanced HTML. Multi-code SGR sequences fully processed. 2 MB render cap — oversized attachments show a "Download raw output" blob-URL link instead of freezing the browser
- **P3.5 · Emergency cleanup hooks**: `uncaughtException` and `unhandledRejection` process handlers call credential cleanup and `tasks.setResult(Failed)` before exiting

### Changed

- **P3.6 · Set-based env var tracking**: `EnvironmentVariableHelper.trackedVariables` switched from `string[]` to `Set<string>` for idempotent re-registration and cleaner cleanup

**162 tests passing** (150 TerraformTaskV5 + 12 TerraformInstallerV1)

## [0.7.2] — 2026-04-17

### Fixed

- **Installer**: detect 32-bit x86 agents via `os.arch() === "ia32"` (Node's actual value) in addition to the previously-matched `x32`; `ia32` path was unreachable before
- **task.json**: rename the `fileName` input on the `show` and `custom` commands to `filename` to match `tasks.getInput("filename")` in the handler. `show`/`custom` → file had silently produced no output file because the input name mismatched; matching Strings entries also renamed (#101)
- **task.json**: correct the `backendAzureRmUseCliFlagsForAuthentication` help text — schema default is `false`, not `true`; help now matches the default

### Documentation

- New `docs/migration-from-ms-devlabs.md`: task rename table, service-connection type renames, side-by-side install, input-rename notes
- README: command table now lists all **16** supported commands (added `import`, `forceunlock`, `refresh`); OCI providers row notes WIF is not yet supported; Differences-from-DevLabs table updated from 13 to 16 commands; link added to migration guide
- CONTRIBUTING: new **Terraform Plan Tab** section covering `src/tab/` layout, the `build:release` flow, webpack bundling, and the `package:self` private-publish loop
- `docs/troubleshooting.md`: document Azure auth-scheme case-insensitivity plus the AWS/GCP exact-match gotcha; clarify OIDC federated-token 30s-per-attempt timeout and 3-attempt retry; expand the multi-provider warning section (including the known substring false-positive)
- New `docs/roadmap.md`: 7-phase plan for April 2026 codebase review — correctness, docs drift, security hardening, test backfill, CI/CD hardening, architecture improvements, observability

### Chore

- Add `tsconfig.tsbuildinfo` to `.gitignore` and untrack the two previously-committed `tsconfig.tsbuildinfo` files
- Delete stale `IMPLEMENTATION_PLAN.md`

### Security

- Override `serialize-javascript` → `^7.0.0` (was 6.0.2 via mocha) — fixes RCE via `RegExp.flags` (high) and CPU exhaustion DoS (moderate) in both V5 and InstallerV1
- Override `diff` → `^8.0.3` (was 7.x via mocha) — fixes low-severity ReDoS advisory
- Bump `follow-redirects` via `npm audit fix` — fixes auth header leak on cross-domain redirects (moderate)
- Regenerate Tests lockfile to purge ghost `nock` → `lodash.set@4.3.2` dependency (prototype pollution, high)

## [0.7.1] — 2026-04-13

### Security

- **Secret masking**: `AWS_SECRET_ACCESS_KEY`, `ARM_OIDC_TOKEN`, `ARM_OIDC_REQUEST_TOKEN`, `ARM_CLIENT_SECRET`, and `TF_TOKEN_app_terraform_io` are now explicitly registered via `tasks.setSecret()` when set as environment variables — the `isSecret: true` flag was missing from all provider handler calls, risking accidental log exposure
- **`binaryName` input validation**: restrict accepted values to `terraform`, `tofu`, `terragrunt` — prevents arbitrary binary execution from pipeline task input

### Added

- `.github/CODEOWNERS` — `@sethbacon` owns all files; `.github/`, `configs/`, and `azure-devops-extension.json` require explicit owner review
- `.github/dependabot.yml` — weekly automated dependency updates for GitHub Actions and npm (TerraformTaskV5, TerraformInstallerV1, root)

### Changed

- `THIRD_PARTY_NOTICES.md`: add language tag to fenced code blocks

## [0.7.0] — 2026-04-09

### Added

- **Terraform Plan tab** in pipeline build results — displays plan output with ANSI color rendering, accessible from the build results view when the task is used
- **`publishPlanResults` input** on the `plan` command — set a plan name (e.g. `production`) to publish plan output as a pipeline attachment visible in the Terraform Plan tab
- Multi-plan selector dropdown when multiple plan steps publish results in the same pipeline run
- `THIRD_PARTY_NOTICES.md` — attribution for jason-johnson/azure-pipelines-tasks-terraform and JaydenMaalouf/azure-pipelines-terraform-output reference implementations
- New devDependencies: `azure-devops-extension-sdk`, `azure-devops-extension-api`, `react`, `react-dom`, `ts-loader`, `style-loader`, `css-loader`
- Tab webpack entry point with TypeScript and CSS loader support
- 1 new test: plan with `publishPlanResults` attachment publishing — **148 tests passing**

### Changed

- `azure-devops-extension.json`: added `terraform-plan-tab` build-results-tab contribution with `supportsTasks` filtering to V5 task GUID
- `webpack.config.js`: added tab entry point and `index.html` copy rule
- `plan()` method captures stdout via `execWithStdoutCapture` when `publishPlanResults` is set, writes to temp file, and publishes as `terraform-plan-results` attachment

## [0.6.1] — 2026-04-09

### Security

- **GPG signature verification**: HashiCorp downloads now verify `SHA256SUMS.sig` against embedded GPG public key (key ID `34365D9472D7468F`) before trusting SHA256 checksums — closes the #1 HIGH security finding across all code reviews
- Hard fail if `.sig` file is present but signature verification fails; graceful degradation if `.sig` unavailable (custom mirrors)
- InstallerV1 ESLint parity: enforce `no-floating-promises` and `return-await` as errors (matches V5)
- Fix floating promise in InstallerV1 entry point (`run()` → `void run()`)

### Added

- **`refresh` command** — dedicated drift detection with full provider auth, var-file, target, parallelism, secure var file, and terraform variables support
- **`varFile` multiline input** — first-class `-var-file` support (one path per line), visible for plan/apply/destroy/import/refresh
- **`targetResources` multiline input** — first-class `-target` support (one address per line), visible for plan/apply/destroy/refresh
- `openpgp@^6.0.1` dependency for OpenPGP detached signature verification
- `gpg-verifier.ts` module with `verifyGpgSignature()` function
- `hashicorp-gpg-key.ts` with embedded HashiCorp GPG public key
- `fetchBuffer()` in `http-client.ts` for binary content downloads
- `parseSha256()` extracted as pure function for testability
- Input validation: target resource addresses validated against Terraform address regex; parallelism validated as positive integer; replace address validated
- 8 new tests: refresh (2), var-file (1), target (1), GPG verification (3), total **158 tests** (147 V5 + 11 InstallerV1)

### Changed

- V5 TypeScript target upgraded from ES6 to ES2020 (Node 20 supports ES2022+)
- Both tasks now declare `engines.node >= 20` in `package.json`
- Refactor `appendTerraformVariables()` from string interpolation to `ToolRunner.arg()` for proper shell escaping
- `warnIfMultipleProviders()` now catches errors internally (non-fatal)
- `downloadZipFromHashiCorp()` fetches full SHA256SUMS content, verifies GPG signature, then parses hash
- GPG verifier mocked in all 8 existing installer tests to prevent openpgp module interference

### Fixed

- Fix double-space in JSON plan command options string
- Update 4 existing terraform variables test mocks for new `-var` arg ordering

## [0.5.2] — 2026-04-08

### Security

- Add output redaction warnings for sensitive Terraform plan data (`warnIfSensitiveOutputs`)
- Fix OCI private key chmod: platform-aware error handling (throws on Linux/macOS, skips gracefully on Windows)
- Strengthen OCI PAR URL validation: `new URL()` parsing plus expanded forbidden template patterns (`${`, `%{`, `$((`, backtick)
- Add exponential backoff retry logic to OIDC token requests (3 attempts, 200ms initial backoff)
- Mark secret environment variables with `tasks.setSecret()` via new `isSecret` parameter on `setEnvironmentVariable()`

### Added

- `terraformVariables` multiline input for direct `-var` support on plan, apply, destroy, and import commands
- Detect destroy changes in JSON plan output: sets `destroyChangesPresent` pipeline variable and emits warning
- Code coverage enforcement via `nyc` with thresholds: 75% lines/functions, 70% branches
- Troubleshooting guide (`docs/troubleshooting.md`) covering auth, terraform, installer, and agent issues
- New test coverage: import command, force-unlock command, OCI parity (6 tests), terraform variables, parallelism, lockfile-readonly, fmt diff, test filter/junit, show-to-file JSON with sensitive output detection — **143 tests passing**

### Changed

- CI Node.js version updated from 18 to 20 LTS
- ESLint rules escalated from warnings to errors; added `no-floating-promises` and `return-await`
- ESLint configs exclude `**/*.mjs` from type-checked linting
- Enhanced `task.json` help text with code examples and Terraform CLI docs links
- `.gitignore` updated to exclude `.nyc_output/` and `coverage/` directories

### Fixed

- Fix floating promise in `index.ts` (`run()` → `void run()`)
- Fix `return-await` lint violations across base handler and id-token-generator
## [0.5.1] — 2026-04-08

### Security

- Upgrade `azure-pipelines-task-lib` from `^4.1.0` to `^5.2.8` in both V5 and InstallerV1 — fixes minimatch ReDoS vulnerabilities (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74)

### Fixed

- CI audit now uses `--omit=dev` and fails on production vulnerabilities instead of silently continuing
- Set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` on release workflow to address Node.js 20 deprecation in `softprops/action-gh-release`
- Fix lint warnings: `let` → `const` in import command, eslint-disable for untyped securefiles-common require

## [0.5.0] — 2026-04-08

### Security

- Move credential temp files (AWS OIDC tokens, GCP credentials JSON, GCP WIF credentials, OCI key files) from working directory to `os.tmpdir()` — prevents accidental commit and reduces exposure window
- Add `.gitignore` patterns for credential file types (`credentials-*.json`, `gcp-wif-credentials-*.json`, `keyfile-*.pem`, `*.jwt`, `config-*.tf`, `output-*.json`, `.env`)
- Restrict OCI config file permissions with `fs.chmodSync(path, 0o600)` after write
- Change `backendHCPToken` input type from `string` to `password` for log masking

### Added

- **Backend WIF for AWS S3**: `backendAuthSchemeAWS` picker with `backendAWSRoleArn`, `backendAWSRegion`, `backendAWSSessionName` inputs — OIDC authentication for S3 backend during `init`
- **Backend WIF for GCP GCS**: `backendAuthSchemeGCP` picker with `backendGCPProjectNumber`, `backendGCPWorkloadIdentityPoolId`, `backendGCPWorkloadIdentityProviderId`, `backendGCPServiceAccountEmail` inputs — OIDC authentication for GCS backend during `init`
- **Secure variables file**: `secureVarsFile` input (type `secureFile`) for plan/apply/destroy/import — downloads `.tfvars` from ADO Secure Files library and passes as `-var-file=<path>` with automatic cleanup
- **Az login integration**: `runAzLogin` boolean for AzureRM provider — runs `az login` using service connection credentials (WIF/ServicePrincipal/MSI) before terraform commands for local-exec provisioners and external data sources
- **OpenTofu support**: `binaryName` picker (terraform/tofu) — all commands and provider detection use the selected binary
- **Import command**: `terraform import` with `importAddress` and `importId` inputs
- **Force-unlock command**: `terraform force-unlock` with `lockId` input
- Auto-set pipeline variables from `terraform output` as `TF_OUT_<key>` (sensitive outputs marked as secrets)
- Destroy change detection: `destroyChangesPresent` output variable set when `terraform show -json` contains resource deletions
- Implement previously-unused inputs: `refreshOnly` (plan/apply), `lockfileReadonly` (init), `parallelism` (plan/apply/destroy), `testJunitXmlPath` and `testFilter` (test), `fmtDiff` (fmt)
- Process signal handlers (`SIGTERM`/`SIGINT`) for emergency credential cleanup
- `outputTo` now visible for `custom` command (was only `show`)

### Changed

- **Installer modernization**: Replace `node-fetch` v2 + `https-proxy-agent` v5 with built-in `fetch()` + `undici.ProxyAgent`; extract mockable `http-client.ts` module
- Add `azure-pipelines-tasks-securefiles-common` dependency for Secure Files support
- Extract 7+ helper methods in base handler to reduce code duplication (`getWorkingDirectory`, `getServiceName`, `createAuthCommand`, `createBaseCommand`, `ensureAutoApprove`, `prependReplaceFlag`, `prependRefreshOnly`, `appendParallelism`, `appendSecureVarFile`)
- AWS backend credentials now use environment variables (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) instead of `-backend-config` CLI args
- Update error message for tool-not-found to mention both terraform and tofu

### Fixed

- Update all GCP init test mocks to use `os.tmpdir()` credential paths
- Update all AWS init test mocks to remove exposed access_key/secret_key from exec strings
- Update all installer test mocks from `node-fetch` to `./http-client` module mocks

**134 tests passing** (126 TerraformTaskV5 + 8 TerraformInstallerV1)

## [0.4.1] — 2026-04-07

### Fixed

- Make `npm audit` CI step non-blocking (`continue-on-error`) — pre-existing `azure-pipelines-task-lib` vulnerability in `minimatch` requires a breaking upgrade to resolve

## [0.4.0] — 2026-04-07

### Security

- Mask GCP private key with `tasks.setSecret()` for log masking parity with OCI/AWS/HCP (#60)
- Validate OCI PAR URL: require HTTPS scheme, reject HCL interpolation sequences `${` / `%{` (#61)
- Set file permissions `0o600` on all credential temp files — PEM keys, JSON credentials, JWT tokens (#62)
- Throw error on unrecognized Azure auth scheme instead of silent ServicePrincipal fallback (#63)

### Changed

- Drop Node16 execution target from both tasks; Node20 is now the sole target (#67)

### Fixed

- Add `showFilePath` and `customFilePath` to `task.json` `outputVariables` for ADO UI discoverability (#65)

### Added

- `npm audit --audit-level=high` CI step for dependency vulnerability scanning (#64)
- Version consistency check script (`scripts/check-versions.js`) and CI job (#68)
- Test command coverage for AWS, GCP, OCI providers; custom command coverage for AWS (#66)
- Document standard test helper pattern in CONTRIBUTING.md (#69)

## [0.3.3] — 2026-04-07

### Fixed

- Replace `execSync` with `execAsync` for file output in `show()`, `output()`, `custom()`, and `warnIfMultipleProviders()` (#46)

### Changed

- Migrate 117 L0 test handler files to shared `runCommand()` helper, reducing ~1,600 lines of boilerplate (#44)

### Added

- OCI validate, show-to-console, and output test coverage (#45)

## [0.3.2] — 2026-04-07

### Security

- Mask OCI private key with `tasks.setSecret()` before processing (#30)
- Add OIDC URL guard (`SYSTEM_OIDCREQUESTURI` check) and error handling to `id-token-generator.ts` (#31, #32)
- Escape backslash and double-quote characters in OCI PAR URLs before embedding in generated HCL backend config (#42)

### Fixed

- Rewrite `id-token-generator.ts`: proper error handling for fetch, HTTP status checks, response validation (#31, #32)
- Add runtime validation for external JSON responses in installer (`fetchJson` guard) (#40)
- Use `tasks.loc()` for non-localized log string in installer (#39)
- Extract hardcoded fallback Terraform version to `FALLBACK_TERRAFORM_VERSION` constant (#38)
- Defer proxy config evaluation to download time in installer (#47)
- Mirror SHA256 skip now uses `tasks.warning()` instead of `console.warn()` (#33)

### Changed

- Upgrade `uuid` from v3 (`^3.4.0`) to v9 (`^9.0.1`), `@types/uuid` to `^9.0.8` across V5 and InstallerV1 (#35)
- Replace all loose equality (`==`, `!=`) with strict equality (`===`, `!==`) or truthiness checks (#36)
- Replace `var` declarations with `const`/`let` throughout (#37)
- Extract duplicated backend config loop from provider handlers into `BaseTerraformCommandHandler.applyBackendConfig()` (#41)
- Make `warnIfMultipleProviders()` async (#43)
- Resolve all 61 ESLint warnings: `prefer-const`, unused params (`_` prefix convention), unused imports
- Add `argsIgnorePattern`/`varsIgnorePattern` to ESLint `no-unused-vars` rule
- Delete `src/types.d.ts` ambient declaration shim (no longer needed with uuid v9)
- Update all 18 test mock registrations from `uuid/v4` to `uuid` module

### Chore

- Sync InstallerV1 `task.loc.json` with `task.json` (matching id, name, author, execution targets) (#34)

---

## [0.3.1] — 2026-04-07

### Refactored

- Replace `(handler as any)[command]()` dynamic dispatch with typed `executeCommand()` method on `BaseTerraformCommandHandler`; `parent-handler.ts` now calls `handler.executeCommand(command)` with no unsafe cast
- Remove `VALID_COMMANDS` whitelist array from `parent-handler.ts` — the dispatch map in `executeCommand()` IS the whitelist
- Standardize all provider handlers (AWS, GCP, OCI) to use `EnvironmentVariableHelper.setEnvironmentVariable()` instead of direct `process.env` assignment, consistent with the Azure handler
- Replace `var` with `const`/`let` throughout `azure-terraform-command-handler.ts`
- Type `TerraformToolHandler` constructor parameter from `any` to `typeof import('azure-pipelines-task-lib/task')`
- Wrap switch case blocks in braces in `azure-terraform-command-handler.ts` to satisfy `no-case-declarations` ESLint rule

### Dependencies

- Migrate ESLint 8 (`.eslintrc.json`) → ESLint 9 flat config (`eslint.config.mjs`) with `typescript-eslint@8` in both TerraformTaskV5 and TerraformInstallerV1
- Update CI lint step to drop `--ext .ts` flag (ESLint 9 uses config-based file filtering)
- Remove dead devDependencies: `@types/q` from TerraformTaskV5 and TerraformInstallerV1; `nock` from TerraformTaskV5 Tests
- Add `uuid@^9.0.1` as a direct dependency in TerraformTaskV5
- Regenerate `package-lock.json` for both tasks (lockfileVersion 3)

### Fixed

- Update TerraformInstallerV1 tests to use `runAsync()` — sync `run()` was removed in `azure-pipelines-task-lib@4.x`

### Tests

- Add 15 new test cases; total **117 tests passing (TerraformTaskV5)**
  - ShowTests: AWS show (console), GCP show (console)
  - OutputTests: AWS output, GCP output
  - WorkspaceTests: workspace new, workspace delete, workspace show
  - StateTests: state show, state mv, state rm, state pull
  - ApplyTests: AWS WIF apply, GCP WIF apply
  - DestroyTests: AWS WIF destroy, GCP WIF destroy

### Removed

- Delete TerraformTaskV1, V2, V3, V4 task directories
- Delete TerraformInstallerV0 task directory
- Delete Microsoft-internal `.azure-pipelines/` CI files (unusable from fork)

---

## [0.3.0] — 2026-04-06

### Security

- Mask AWS backend credentials with `tasks.setSecret()` (access_key, secret_key)
- Mask Azure ARM_CLIENT_SECRET with `tasks.setSecret()` for ServicePrincipal auth
- Mask HCP API token with `tasks.setSecret()`
- Register OCI private key file and generated .tf config for temp file cleanup
- Fix proxy URL construction in installer using `URL` class (prevents malformed URLs with special characters)

### Fixed

- Fix GCP backend prefix: treat `backendGCPPrefix` as optional (no longer crashes when omitted)
- Fix output/show/custom file paths to resolve relative to `workingDirectory` instead of `process.cwd()`
- Fix `azure-devops-extension.json`: correct `"Tags"` → `"tags"` (marketplace schema), fix `"aws-enpoint-type"` typo
- Fix OCI handler typo `tfConfigyFilePath` → `tfConfigFilePath`
- Add missing `TerraformPlanFailed` localization key to task.json

### Added

- OCI provider tests: init, plan, apply, destroy
- Backend decoupling test: S3 backend with AzureRM provider
- ESLint configuration and CI lint step for V5 and InstallerV1
- ESLint devDependencies (`eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`)

### Changed

- Bump TypeScript from `^4.0.0` to `^5.0.0` in V5 and InstallerV1
- Bump `@types/node` to `^20.11.0`, `@types/mocha` to `^10.0.0` in V5 and InstallerV1
- Remove Node10 execution target from V5 and InstallerV1 task.json (Node16 + Node20_1 remain)
- Remove dead `del` dependency and unused `compareVersions()` method from base handler
- Replace `const fs = require('fs')` with `import fs = require('fs')` in base handler
- Update `author` to `sethbacon` and `helpMarkDown` to GitHub URL in task.json files
- Add `optimization.minimize: false` and `performance.hints: false` to webpack config
- Exclude `tsconfig*.json` and `.eslintrc.json` from webpack VSIX copy
- Rewrite `overview.md` to document fork capabilities

### Documentation

- Review and fix all markdown documentation for correctness
- Add implementation status to initiative docs (1, 2, 3 all marked COMPLETED)
- Update CLAUDE.md: fix Node10 reference, add missing commands, fix test description
- Fix CONTRIBUTING.md: correct test command description, add InstallerV1 test info
- Fix overview.md: correct backendType default behavior description
- Fix InstallerV1 README: update support links, fix typos, fix markdown formatting
- Fix V5 README: replace Microsoft aka.ms link with fork documentation link
- Update initiative-3: mark HCP as completed, note generic/local handler routing

### Removed

- Delete empty `temp.js` artifact from repo root
- Delete orphaned `L0CompareVersions.ts` test file (method was removed)

**102 tests passing (TerraformTaskV5)**

---

## [0.2.3] — 2026-03-22

### Documentation

- Rewrote README from scratch: fork identity, task reference (`PipelineTerraformInstaller@1`, `PipelineTerraformTask@5`), all 13 commands, all 7 `backendType` options, provider/auth table, service connection types, WIF quick-reference YAML, differences-from-MS-DevLabs comparison table
- Replaced SECURITY.md with GitHub Security Advisory guidance (removed Microsoft MSRC contact)
- Updated SUPPORT.md: removed Microsoft references, retained GitHub Issues guidance
- Replaced CODE_OF_CONDUCT.md with Contributor Covenant v2.1 (removed Microsoft OSS CoC)

---

## [0.2.1] — 2026-03-18

### Fixed
- Reverted task GUIDs to original values for marketplace compatibility (marketplace enforces GUID consistency across extension versions)
- Fixed task name consistency across V1-V4 versions (all now use `PipelineTerraformTask`)

---

## [0.2.0] - 2026-03-18

### Breaking Changes

- **Task rename for side-by-side install**: Tasks renamed to `PipelineTerraformTask` and `PipelineTerraformInstaller` with new unique GUIDs. Pipeline YAML references must change to `PipelineTerraformTask@5` and `PipelineTerraformInstaller@1`. This allows coexistence with the original MS DevLabs extension.

### Security

- **Credential debug logging removed** (HIGH): `environment-variables.ts` no longer logs secret values in `tasks.debug()` output
- **Command whitelist added** (MEDIUM): `parent-handler.ts` validates commands against a static whitelist before dynamic dispatch
- **SHA256 verification for HashiCorp downloads**: Installer now fetches and verifies `SHA256SUMS` for HashiCorp and mirror downloads (registry already had this)
- **AWS secrets registered for masking**: `tasks.setSecret()` called on AWS secret access key to prevent pipeline log exposure
- **Temp credential file cleanup**: OIDC token files and GCP credential JSON files are now deleted after terraform execution via `cleanupTempFiles()` in a `finally` block
- **GCP credentials built with JSON.stringify**: Replaced unsafe template literal with `JSON.stringify()` for service account JSON construction
- **URL-encoded serviceConnectionId**: `id-token-generator.ts` uses `encodeURIComponent()` for the OIDC request URL
- **chmod 755**: Installer binary permissions changed from `777` to `755`
- **Error handling hardened**: `index.ts` properly extracts error messages with `instanceof Error` check

### Added

- **HCP Terraform Cloud backend**: New `backendType: hcp` with `backendHCPToken`, `backendHCPOrganization`, `backendHCPWorkspace` inputs
- **InstallerV1 test suite** (8 tests): HashiCorp latest/specific version, cached install, registry download, mirror download, insecure URL rejection, SHA256 mismatch, invalid version
- **V5 command tests** (5 tests): show (console + file), output, custom, terraform test command
- **Test helper factory**: `Tests/test-helpers.ts` and `Tests/test-l0-helpers.ts` reduce boilerplate for new tests
- **Strict TypeScript**: Both V5 and InstallerV1 compile with `strict: true`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- **Type declaration** for `uuid/v4` module (`src/types.d.ts`)
- **Split tsconfig**: `tsconfig.json` (strict, src only) and `tsconfig.tests.json` (relaxed, includes tests) for each task

### Fixed

- **Return type bugs**: `show()`, `output()`, `custom()` methods now correctly return `commandOutput.code` (number) instead of the full `IExecSyncResult` object
- **Missing default case**: `getServiceProviderNameFromProviderInput()` now throws for unknown providers instead of returning `undefined`
- **Invalid outputTo handling**: `show()` and `custom()` throw descriptive errors instead of silently returning `undefined`

---

## [0.1.0] - 2026-03-07

First published release of the `sethbacon.pipeline-tasks-terraform` fork.

### Added

#### Foundation (Part 0)

- CI workflow (`.github/workflows/unit-test.yml`): `actions/checkout@v4`, `actions/setup-node@v4` pinned to Node 18 LTS, removed legacy V4 job, added TerraformInstallerV1 build job
- Release workflow (`.github/workflows/release.yml`): semver-tag-triggered, guards tag is on `main`, runs CI, packages `.vsix`, publishes to VS Marketplace, creates GitHub Release
- `configs/release.json`: release manifest override for `sethbacon` publisher
- `CHANGELOG.md`, `CLAUDE.md`, `CONTRIBUTING.md`: project documentation
- `docs/initiatives/`: initiative planning documents
- `docs/setup/aws-wif-setup.md`, `docs/setup/gcp-wif-setup.md`: Workload Identity Federation setup guides

#### Initiative 2: Complete CLI Coverage (TerraformTaskV5)

- `workspace` command with `workspaceSubCommand` (new/select/list/delete/show) and `workspaceName` inputs
- `state` command with `stateSubCommand` (list/pull/push/mv/rm/show) and `stateAddress` inputs
- `fmt` command with `fmtCheck` (fail if formatting needed) and `fmtRecursive` inputs
- `get` command for Terraform module download
- `-replace` flag input on `plan` and `apply` (`replaceAddress`) as the modern replacement for the deprecated `taint` command
- Tests for all new commands (WorkspaceTests, StateTests, FmtTests, GetTests, plan/apply with -replace)

#### Initiative 3: Workload Identity Federation for AWS and GCP (TerraformTaskV5)

- AWS WIF support: `environmentAuthSchemeAWS` (ServiceConnection / WorkloadIdentityFederation), `awsRoleArn`, `awsRegion`, `awsSessionName` inputs; writes OIDC JWT to temp file, sets `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`
- GCP WIF support: `environmentAuthSchemeGCP` (ServiceConnection / WorkloadIdentityFederation), `gcpProjectNumber`, `gcpWorkloadIdentityPoolId`, `gcpWorkloadIdentityProviderId`, `gcpServiceAccountEmail` inputs; builds external account credentials JSON for `GOOGLE_CREDENTIALS`
- Backend/provider decoupling: new `backendType` input (`azurerm`/`s3`/`gcs`/`oci`/`generic`/`local`) — for `init`, backend type selects the handler independently of the deployment `provider`
- Generic backend handler (`TerraformCommandHandlerGeneric`): `backendConfigFile` and `backendConfigArgs` (key=value lines) inputs passed as `-backend-config` flags to `terraform init`
- Backwards-compatible: existing pipelines without `backendType` continue to work (falls back to `provider`)
- Tests for generic init, AWS WIF plan, GCP WIF plan (92 total tests passing)

### Changed

- Extension manifest: publisher `sethbacon`, id `pipeline-tasks-terraform`, name `Pipeline Tasks for Terraform`
- Service endpoint type names made globally unique: `PTTAWSServiceEndpoint`, `PTTGoogleCloudServiceEndpoint`, `PTTOCIServiceEndpoint`
- Upgraded `tfx-cli` from `0.16.0` to `0.23.1`
- `parent-handler.ts`: routing decoupled for init (backend) vs. other commands (provider); added Generic/Local handler
- TerraformTaskV5 mocha upgraded to `^11.2.0` for Node 25 compatibility
- `visibleRule` expressions simplified to supported syntax (no `||` or parentheses)

---

## Fork History

This project is a fork of [azure-pipelines-terraform](https://github.com/microsoft/azure-pipelines-terraform) by Microsoft DevLabs (MIT License). The original extension was published as `ms-devlabs.custom-terraform-tasks`. Version history prior to this fork is maintained in the upstream repository.
