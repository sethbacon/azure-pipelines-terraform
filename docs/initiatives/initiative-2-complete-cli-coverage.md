# Initiative 2: Complete Terraform CLI Command Coverage

## Implementation Status

**Status: COMPLETED** — All commands (workspace, state, fmt, test, get) and the -replace flag are implemented in TerraformTaskV5.

## Goal

Add all high-value Terraform CLI commands as first-class pipeline steps, and ensure new commands can be added with minimal boilerplate.

## Current State (V5 commands)

`init`, `validate`, `plan`, `show`, `apply`, `output`, `destroy`, `custom`

## Gap Analysis

| Terraform Command | V5 Support | Priority | Notes |
| --- | --- | --- | --- |
| `workspace new/select/list/delete/show` | None | High | Common for multi-env deployments |
| `state list/pull/push/mv/rm/show` | None | High | Essential for state management/migration |
| `-replace=ADDRESS` on plan/apply | Partial (via commandOptions) | High | Modern replacement for `taint`; add as dedicated input |
| `get` | None | Medium | Module download (usually covered by `init -upgrade`) |
| `fmt -check` | None | Medium | Code style enforcement in CI |
| `test` | None | High | Terraform 1.6+ native test framework |
| `import` | None | Medium | Config-driven import in 1.5+ |
| `taint` / `untaint` | **Not added** | N/A | Removed in Terraform 1.0; use `-replace` flag instead |
| `providers mirror` | None | Low | Air-gapped environments only |
| `force-unlock` | None | Low | Emergency use, high risk |
| `console` | None | Low | Not useful in CI/CD |
| `refresh` | None | Low | Deprecated in 1.x |

## Decisions

**`taint` / `untaint`:** Not added. These commands were removed in Terraform 1.0. The `-replace` flag input on `plan` and `apply` is the correct modern equivalent. Users on Terraform < 1.0 can use the existing `custom` command.

**Architecture:** Keep the existing method dispatch pattern. Add new methods to `BaseTerraformCommandHandler`. Do not introduce a command registry pattern — reserve that for a future breaking version.

## Files to Modify

| File | Change |
| --- | --- |
| `Tasks/TerraformTask/TerraformTaskV5/task.json` | Add new commands + sub-command inputs |
| `Tasks/TerraformTask/TerraformTaskV5/task.loc.json` | Add localization keys |
| `Tasks/TerraformTask/TerraformTaskV5/Strings/.../resources.resjson` | Add localized strings |
| `Tasks/TerraformTask/TerraformTaskV5/src/base-terraform-command-handler.ts` | Add new command methods |
| `Tasks/TerraformTask/TerraformTaskV5/Tests/` | Add test folders for each new command |

## Versioning

Bump TerraformTaskV5 task `Minor` version. Do not create V6 — additive features stay in V5.

## New Commands

### `workspace`

Sub-command controlled by `workspaceSubCommand` input (new/select/list/delete/show). The `workspaceName` input is required for new/select/delete.

Does NOT need provider auth (no `handleProvider()` call needed).

**New task.json inputs:**

```json
{
  "name": "workspaceSubCommand",
  "type": "pickList",
  "label": "Workspace sub-command",
  "visibleRule": "command = workspace",
  "required": true,
  "options": {
    "new": "new",
    "select": "select",
    "list": "list",
    "delete": "delete",
    "show": "show"
  }
},
{
  "name": "workspaceName",
  "type": "string",
  "label": "Workspace name",
  "visibleRule": "command = workspace && (workspaceSubCommand = new || workspaceSubCommand = select || workspaceSubCommand = delete)",
  "required": true
}
```

**Implementation in `base-terraform-command-handler.ts`:**

```typescript
public async workspace(): Promise<number> {
    const subCommand = tasks.getInput("workspaceSubCommand", true);
    const workspaceName = tasks.getInput("workspaceName", false);

    let workspaceCommand = new TerraformBaseCommandInitializer(
        `workspace ${subCommand}`,
        tasks.getInput("workingDirectory"),
        workspaceName ? `${workspaceName} ${tasks.getInput("commandOptions") || ""}`.trim()
                      : tasks.getInput("commandOptions")
    );

    const terraformTool = this.terraformToolHandler.createToolRunner(workspaceCommand);
    return await terraformTool.execAsync(<IExecOptions>{
        cwd: workspaceCommand.workingDirectory
    });
}
```

### `state`

Sub-command controlled by `stateSubCommand` input. Address/arguments via `stateAddress`.

Does NOT need provider auth.

**New task.json inputs:**

```json
{
  "name": "stateSubCommand",
  "type": "pickList",
  "label": "State sub-command",
  "visibleRule": "command = state",
  "required": true,
  "options": {
    "list": "list",
    "pull": "pull",
    "push": "push",
    "mv": "mv",
    "rm": "rm",
    "show": "show"
  }
},
{
  "name": "stateAddress",
  "type": "string",
  "label": "State address / arguments",
  "visibleRule": "command = state",
  "required": false,
  "helpMarkDown": "Resource address(es) for the state sub-command. For mv: 'SOURCE DESTINATION'. For rm/show/list: 'ADDRESS'."
}
```

Note: `state push` is a potentially destructive operation. The implementation should emit a warning when `stateSubCommand = push`.

### `-replace` flag on `plan` and `apply`

Add a `replaceAddress` input visible when `command = plan` or `command = apply`. Appended as `-replace=<address>` to the command arguments.

**New task.json input:**

```json
{
  "name": "replaceAddress",
  "type": "string",
  "label": "Replace resource address",
  "visibleRule": "command = plan || command = apply",
  "required": false,
  "helpMarkDown": "Force replacement of a specific resource. Equivalent to terraform plan/apply -replace=ADDRESS. Requires Terraform 1.0+."
}
```

In `plan()` and `apply()` in `base-terraform-command-handler.ts`, append `-replace=<address>` to `additionalArgs` if the input is non-empty.

### `fmt`

**New task.json inputs:**

```json
{
  "name": "fmtCheck",
  "type": "boolean",
  "label": "Check mode (fail if formatting needed)",
  "visibleRule": "command = fmt",
  "defaultValue": "true"
},
{
  "name": "fmtRecursive",
  "type": "boolean",
  "label": "Recursive",
  "visibleRule": "command = fmt",
  "defaultValue": "true"
}
```

Does NOT need provider auth.

**Implementation:**

```typescript
public async fmt(): Promise<number> {
    let args = "";
    if (tasks.getBoolInput("fmtCheck", false)) { args += " -check"; }
    if (tasks.getBoolInput("fmtRecursive", false)) { args += " -recursive"; }
    const commandOptions = tasks.getInput("commandOptions");
    if (commandOptions) { args += ` ${commandOptions}`; }

    const fmtCommand = new TerraformBaseCommandInitializer(
        "fmt",
        tasks.getInput("workingDirectory"),
        args.trim()
    );
    const terraformTool = this.terraformToolHandler.createToolRunner(fmtCommand);
    return await terraformTool.execAsync(<IExecOptions>{
        cwd: fmtCommand.workingDirectory
    });
}
```

### `test`

Requires Terraform 1.6+. Uses provider auth (may need cloud credentials for integration tests).

**Implementation:**

```typescript
public async test(): Promise<number> {
    const serviceName = `environmentServiceName${this.getServiceProviderNameFromProviderInput()}`;
    const testCommand = new TerraformAuthorizationCommandInitializer(
        "test",
        tasks.getInput("workingDirectory"),
        tasks.getInput(serviceName, true),
        tasks.getInput("commandOptions")
    );
    const terraformTool = this.terraformToolHandler.createToolRunner(testCommand);
    await this.handleProvider(testCommand);
    return await terraformTool.execAsync(<IExecOptions>{
        cwd: testCommand.workingDirectory
    });
}
```

### `get`

Simple module download. Does NOT need provider auth.

**Implementation:**

```typescript
public async get(): Promise<number> {
    const getCommand = new TerraformBaseCommandInitializer(
        "get",
        tasks.getInput("workingDirectory"),
        tasks.getInput("commandOptions")
    );
    const terraformTool = this.terraformToolHandler.createToolRunner(getCommand);
    return await terraformTool.execAsync(<IExecOptions>{
        cwd: getCommand.workingDirectory
    });
}
```

## Test Coverage Required

For each new command:

- Success path with no additional args
- Success path with args
- Failure path (invalid working directory)
- For `workspace` and `state`: error on invalid sub-command input
- For `state push`: verify warning is emitted

Add test folders: `WorkspaceTests/`, `StateTests/`, `FmtTests/`, `TestTests/`, `GetTests/`
