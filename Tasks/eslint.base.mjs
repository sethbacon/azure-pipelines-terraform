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
// lint rules live. A rule added here reaches all 11 tasks at once — the ten that
// call `srcOnlyConfig(tseslint)` and TerraformTaskV5, which spreads `sharedRules`
// into its own (slightly larger) config. Do NOT copy a rule into an individual
// task's eslint.config.mjs; add it here instead, or it will silently apply to
// only that one task (issue #593).

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

// The standard flat config for a task that type-checks and lints only src/ and
// ignores its Tests/ tree (10 of the 11 tasks). TerraformTaskV5 lints its Tests/
// too, so it composes its own config from `sharedRules` instead of calling this.
export function srcOnlyConfig(tseslint) {
    return tseslint.config(
        ...tseslint.configs.recommended,
        {
            languageOptions: {
                parserOptions: {
                    project: './tsconfig.json',
                },
            },
            rules: { ...sharedRules },
        },
        {
            ignores: ['Tests/**', 'node_modules/**', '**/*.js', '**/*.mjs'],
        },
    );
}
