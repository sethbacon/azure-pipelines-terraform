// Shared ESLint flat-config base for every task package's eslint.config.mjs.
//
// WHY A FACTORY: each task is an independent npm package with its OWN
// node_modules, and `typescript-eslint` is installed per task (not at the repo
// root). A bare `import tseslint from 'typescript-eslint'` inside THIS file
// would resolve relative to Tasks/, where that dependency is not installed, and
// fail. So this module takes no bare imports of its own; each task's config
// imports its locally-installed `typescript-eslint` and passes it in.
//
// SINGLE SOURCE OF TRUTH: `sharedRules` is the one place the security-relevant
// lint rules live, and `testsRelaxedRules` is the one place the relaxed rules
// for Tests/ live. A rule added to either reaches all 11 tasks at once via
// `srcAndTestsConfig(tseslint)`. Do NOT copy a rule into an individual task's
// eslint.config.mjs; add it here instead, or it will silently apply to only
// that one task (issue #593).

// The shared rule set enforced on every task's src/ TypeScript.
export const sharedRules = {
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/return-await': 'error',
    'prefer-const': 'error',
    'no-var': 'error',
};

// The relaxed rule set enforced on every task's Tests/ TypeScript. Mock-heavy
// test code legitimately needs looser typing/promise-handling than production
// src/ code (e.g. `any`-typed mock-run fixtures, fire-and-forget promises in a
// test harness) — relax only what test code actually needs, never a rule that
// would mask a real bug in a test's own assertions.
export const testsRelaxedRules = {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-floating-promises': 'off',
    '@typescript-eslint/return-await': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'prefer-const': 'off',
    'no-var': 'off',
};

// The standard flat config for a task: type-checks and lints src/ with
// `sharedRules` (plus any task-specific `extraSrcRules`, merged in — e.g.
// TerraformTaskV5's `no-extra-semi`) and Tests/ with `testsRelaxedRules`, using
// each tree's own tsconfig project.
export function srcAndTestsConfig(tseslint, { extraSrcRules = {} } = {}) {
    return tseslint.config(
        ...tseslint.configs.recommended,
        {
            languageOptions: {
                parserOptions: {
                    project: './tsconfig.json',
                },
            },
            rules: { ...sharedRules, ...extraSrcRules },
        },
        {
            files: ['Tests/**/*.ts'],
            languageOptions: {
                parserOptions: {
                    project: './tsconfig.tests.json',
                },
            },
            // Tests keep their documentary `eslint-disable no-explicit-any` directives on
            // the `as any` monkeypatches even though testsRelaxedRules turns that rule off
            // here, so don't flag those now-redundant directives as "unused": they document
            // why the cast is deliberate and re-arm automatically if no-explicit-any is ever
            // restored for Tests. (src/ keeps the default unused-directive reporting.)
            linterOptions: { reportUnusedDisableDirectives: 'off' },
            rules: { ...testsRelaxedRules },
        },
        {
            // TerraformInstallerV1's Tests/coverage-warmup.cjs (an nyc
            // coverage-warmup helper, not test code) is plain CommonJS and
            // isn't part of any tsconfig project -- without this, the
            // type-aware src/ block above (which has no `files` filter, so it
            // applies to every file) tries to parse it against tsconfig.json
            // and fails with a "file not found in project" parsing error.
            ignores: ['node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
        },
    );
}
