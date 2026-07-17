# Third-Party Notices

This project ships the third-party npm packages listed below inside the published extension,
and is additionally inspired by the projects credited further down. Two different mechanisms
are used: task-level dependencies are installed as ordinary `node_modules` packages copied
into the `.vsix` alongside each task's `tsc`-compiled JavaScript (unmodified, not run through a
bundler); the Terraform results tab's UI dependencies are the exception — they are webpack-
bundled into a single `build/tab/tabContent.js` (see CONTRIBUTING.md's build-flow section).

## Task dependencies (shipped via each task's `node_modules`)

Each package below is distributed under a permissive OSI license; full license texts ship
unmodified in each package's own `node_modules` directory and are available at the linked
repositories.

| Package                                  | Bundled into                                                                                           | License           |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| markdown-it                              | Markdown2Html                                                                                          | MIT               |
| highlight.js                             | Markdown2Html                                                                                          | BSD-3-Clause      |
| js-yaml                                  | Markdown2Html (front matter)                                                                           | MIT               |
| cheerio                                  | Markdown2Html, PublishKbArticle (HTML sanitize/validate)                                               | MIT               |
| openpgp                                  | TerraformInstaller, PolicyAgentInstaller (GPG signature verification)                                  | LGPL-3.0-or-later |
| undici                                   | TerraformInstaller, PolicyAgentInstaller, TerraformDocsInstaller, TerraformTaskV5 (HTTP/proxy client)  | MIT               |
| terraform-drift-contract                 | TerraformDriftReport (drift-summary contract)                                                          | Apache-2.0        |
| azure-pipelines-task-lib                 | All 11 tasks (ADO task SDK — inputs, variables, tool runners)                                          | MIT               |
| azure-pipelines-tool-lib                 | TerraformInstaller, PolicyAgentInstaller, TerraformDocsInstaller (tool download/cache)                 | MIT               |
| azure-devops-node-api                    | TerraformTaskV5 (Azure DevOps REST API client)                                                         | MIT               |
| azure-pipelines-tasks-artifacts-common   | TerraformTaskV5 (shared artifact utilities)                                                            | MIT               |
| azure-pipelines-tasks-securefiles-common | TerraformTaskV5 (secure file download)                                                                 | MIT               |

> **openpgp (LGPL-3.0-or-later) relinking note:** openpgp ships as the unmodified files
> published to npm — copied into `TerraformInstallerV1`'s and `PolicyAgentInstallerV1`'s
> `node_modules/openpgp` as-is, not minified or otherwise transformed into a single bundle.
> The corresponding source for relinking/modification purposes is therefore simply the
> package's public upstream source, https://github.com/openpgpjs/openpgpjs (also retrievable
> from the npm registry tarball for the exact version pinned in each task's `package.json`).

## Terraform results tab dependencies (webpack-bundled)

`src/tab/tabContent.tsx` and its component tree are webpack-bundled into a single
`build/tab/tabContent.js` inside the `.vsix` (see CONTRIBUTING.md). These four packages are
root `devDependencies` (not task-level runtime `dependencies`) but their compiled code is
embedded in that bundle, so they are listed here for completeness:

| Package                    | Bundled into                                       | License |
| --------------------------- | ----------------------------------------------------- | ------- |
| react                      | Terraform results tab (`build/tab/tabContent.js`) | MIT     |
| react-dom                  | Terraform results tab (`build/tab/tabContent.js`) | MIT     |
| azure-devops-extension-sdk | Terraform results tab (`build/tab/tabContent.js`) | MIT     |
| azure-devops-extension-api | Terraform results tab (`build/tab/tabContent.js`) | MIT     |

> Maintained manually: when adding or removing a bundled runtime dependency, update this
> file. (A generated SPDX/license report is a tracked future improvement.)

---

This project is also inspired by the following open-source projects:

---

## jason-johnson/azure-pipelines-tasks-terraform

**Repository:** https://github.com/jason-johnson/azure-pipelines-tasks-terraform
**License:** MIT

The `publishPlanResults` input name, `terraform-plan-results` attachment type convention,
and the general architecture of the Terraform Plan tab (pipeline task publishes plan output
as a build attachment; extension tab reads and renders it) were informed by studying this
extension. No code was copied. All implementation is original.

```txt
MIT License

Copyright (c) 2021 Charles Zipp
Copyright (c) 2023 Jason Johnson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## JaydenMaalouf/azure-pipelines-terraform-output

**Repository:** https://github.com/JaydenMaalouf/azure-pipelines-terraform-output
**License:** MIT

The webpack configuration pattern for bundling Azure DevOps extension tab UI alongside
pipeline tasks, and the `dynamic: true` contribution property were informed by studying
this extension. No code was copied. All implementation is original.

```txt
MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```
