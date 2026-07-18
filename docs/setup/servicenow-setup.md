# ServiceNow Integration Setup — Least-Privilege Guide

This guide covers scoping the ServiceNow integration used by `PublishKbArticle@1` to the minimum access it actually needs, rather than a broad `admin`/`itil_admin` account.

## What the task actually does

`PublishKbArticle@1` talks to two ServiceNow REST surfaces: the Table API (`servicenow-client.ts`) and the Attachment API (`attachments.ts`). These are the only tables/operations it touches:

| Table                            | Operations             | Used for                                                                                                            |
| --------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `kb_knowledge_base`               | Read                    | `kbId: list` — enumerating available knowledge bases                                                                |
| `kb_knowledge`                    | Create, Read, Update    | Creating/updating articles, reading an existing article before an update, source-key lookup, workflow-state transitions |
| `kb_category`                     | Create, Read            | Auto-creating categories/subcategories (`category`/`subcategory` inputs); the task never updates or deletes a category |
| Attachment API (`sys_attachment`) | Create, Read, Delete    | `uploadImages: true` — listing, uploading, and replacing `<img>` attachments on the article via content-hash sync   |

The task never issues a DELETE against `kb_knowledge` or `kb_category`, and never touches any table other than the four above.

## Recommended least-privilege configuration

1. **Create a dedicated integration user** for this pipeline — not a shared human account, not `admin`.
2. **Scope access to the specific knowledge base(s) the pipeline publishes to**, rather than an instance-wide role. ServiceNow's Knowledge Management app supports assigning a **Contributor** role (and, if any step sets `workflowState: publish`, a **Publisher** role) at the individual knowledge-base level, which is narrower than the built-in `knowledge_admin` role that grants management rights over every knowledge base in the instance.
3. **Prefer the built-in `knowledge` role over `knowledge_admin`/`admin`** if your ACL configuration requires a global role at all, and pair it with the KB-level assignment above to keep write access limited to the intended knowledge base(s).
4. **Attachment access:** if your instance's default ACLs grant broader `sys_attachment` access than you want, add a custom ACL restricting the integration user to `table_name=kb_knowledge` attachments only — this task never uploads to any other table.
5. **Workflow-state transitions are a separate consideration from table ACLs.** The task moves an article through `draft` → `review` → `publish` with a direct `PATCH` of `workflow_state` (there is no Table API "publish" action). Depending on your instance's out-of-box Knowledge Management workflow/business rules, transitioning to `published` may require the integration user to hold additional workflow-specific permissions (e.g. being a recognized contributor/publisher on that KB) beyond the raw table ACL — verify the target transition succeeds against a **test** knowledge base before relying on it in production.

## Authentication setup

### Option A: `ServiceNowKb` service connection (recommended)

1. In Azure DevOps: **Project Settings → Service connections → New service connection → ServiceNow for KB Publisher**.
2. Enter the **ServiceNow Instance URL**.
3. Choose an authentication scheme:
   - **OAuth (Client Credentials)** — register an OAuth application in ServiceNow (**System OAuth → Application Registry → New → Create an OAuth API endpoint for external clients**) tied to the scoped integration user from the previous section, and enter its Client ID/Secret.
   - **Basic** — enter the scoped integration user's username/password directly.
4. Reference the connection from the task:

   ```yaml
   - task: PublishKbArticle@1
     inputs:
       serviceConnection: 'my-servicenow-connection'
       kbId: 'my-kb-sys-id'
       title: 'My Article'
       htmlFile: 'MODULE.html'
       author: 'my-servicenow-username'
       workflowState: 'draft'
   ```

### Option B: Inline credentials

Set `instance`, `authType` (`oauth` or `basic`), and the matching `clientId`/`clientSecret` or `username`/`password` inputs directly on the task instead of a service connection. Treat `clientSecret`/`password` as secret pipeline variables — see the `PublishKbArticle@1` input table in the [README](../../README.md).

## Verify

- Run with `dryRun: true` first — this validates auth and logs the planned create/update action without writing to ServiceNow.
- Confirm the scoped integration user can create/update an article and, if `uploadImages: true`, upload and delete an attachment, against a **test** knowledge base before pointing the pipeline at production.

## Security notes

- All requests are sent over HTTPS only — the task refuses to transmit credentials over a non-HTTPS instance URL.
- OAuth tokens and passwords (and their derived/encoded forms) are masked in pipeline logs via `setSecret`.
- See [SECURITY.md](../../SECURITY.md) for other credential-handling details across the extension.
