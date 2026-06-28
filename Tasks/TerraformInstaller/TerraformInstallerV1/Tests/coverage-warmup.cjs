// Coverage warm-up — loaded via `nyc mocha --require` in the `test:coverage`
// script only (not in the plain `test` run).
//
// The integration suites exercise the installer through azure-pipelines-task-lib's
// MockTestRunner, which spawns each task as a child process with mockery enabled.
// Inside that mockery-wrapped child, nyc's Babel-based instrumenter intermittently
// fails to transform the modules that are pulled in via `registerMock` of a
// relative dependency, emitting "Transformation error ... Expected opts.sync to be
// a function" (a @babel/core gensync collision with mockery's require hook) and
// falling back to the *original*, uninstrumented source — which reports as 0%.
//
// Requiring the source modules here, in the in-process mocha runner (no mockery),
// instruments them cleanly and seeds nyc's transform cache. When a child's
// transform then fails, nyc falls back to the cached instrumented copy, so the
// coverage recorded by the spawned children is attributed correctly.
//
// gpg-verifier and terraform-installer are the only modules that are never loaded
// in-process by an L0 unit test, so they are the ones that need warming. (PolicyAgentInstaller
// gets this for free because its InstallerHelpersL0 imports the installer module directly.)
//
// Named `.cjs` (not `.js`) so it is tracked by git — the repo's `.gitignore`
// excludes `Tasks/**/*.js` build output, which would otherwise drop this file.
require('../src/gpg-verifier');
require('../src/terraform-installer');
