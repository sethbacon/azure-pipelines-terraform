/**
 * Build a PARTIAL mock of `@4cloudguru/pipeline-task-ado`.
 *
 * `registerMock` replaces a module wholesale by specifier. The shared package
 * exports several unrelated helpers — `EnvironmentVariableHelper`, the
 * secure-temp writers, the ADO HTTP client — that the handlers under test rely
 * on. A stub supplying only the one symbol a test wants to control silently
 * blanks the rest, which surfaces as `Cannot read properties of undefined
 * (reading 'setEnvironmentVariable')` rather than as a missing-mock error.
 *
 * Spreading the real module keeps every other export live, so each fixture
 * still overrides exactly the symbol it names — and modules moved into the
 * package in future need no change at any call site here.
 *
 * The require is deliberately LAZY (inside the function rather than a
 * top-level import). `azure-pipelines-task-lib` snapshots `INPUT_*` out of
 * `process.env` exactly once, on first require of its task module, and the
 * shared package pulls that module in. A top-level import here would run at
 * fixture load — before the fixture's own `tr.setInput(...)` calls — leaving
 * the input vault empty for the rest of the process. That surfaces as an
 * unrelated-looking `Input required: <name>` failure rather than anything
 * pointing back at this file. Every fixture calls this helper after its
 * `setInput` calls, so requiring at call time is safe.
 */
export function adoPackageMock(overrides: Record<string, unknown>): Record<string, unknown> {
    const actual = require('@4cloudguru/pipeline-task-ado') as Record<string, unknown>;
    return { ...actual, ...overrides };
}
