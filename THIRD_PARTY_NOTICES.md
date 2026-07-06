# Third-Party Notices

This project bundles the third-party npm packages listed below into the published task
handlers (via webpack), and is additionally inspired by the projects credited further down.

## Bundled runtime dependencies

These packages are compiled into one or more shipped task bundles. Each is distributed under
a permissive OSI license; full license texts ship in each package's distribution and are
available at the linked repositories.

| Package      | Bundled into                                                          | License           |
| ------------ | --------------------------------------------------------------------- | ----------------- |
| markdown-it  | Markdown2Html                                                         | MIT               |
| highlight.js | Markdown2Html                                                         | BSD-3-Clause      |
| js-yaml      | Markdown2Html (front matter)                                          | MIT               |
| cheerio      | Markdown2Html, PublishKbArticle (HTML sanitize/validate)              | MIT               |
| openpgp      | TerraformInstaller, PolicyAgentInstaller (GPG signature verification) | LGPL-3.0-or-later |

> Maintained manually: when adding or removing a bundled runtime dependency, update this
> table. (A generated SPDX/license report is a tracked future improvement.)

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
