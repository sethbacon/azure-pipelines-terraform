import tseslint from 'typescript-eslint';
import { sharedRules } from '../../eslint.base.mjs';

// TerraformTaskV5 is the one task that also lints its Tests/ tree (with relaxed
// rules), so it composes its own flat config rather than calling srcOnlyConfig().
// The src/ rule set is still the shared single source of truth — sharedRules is
// spread in below, so a rule added in Tasks/eslint.base.mjs reaches this task too.
export default tseslint.config(
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            ...sharedRules,
            'no-extra-semi': 'error',
        },
    },
    {
        files: ['Tests/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.tests.json',
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/return-await': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'prefer-const': 'off',
            'no-var': 'off',
        },
    },
    {
        ignores: ['node_modules/**', '**/*.js', '**/*.mjs'],
    }
);
