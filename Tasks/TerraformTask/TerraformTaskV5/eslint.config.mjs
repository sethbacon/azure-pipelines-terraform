import tseslint from 'typescript-eslint';

export default tseslint.config(
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/return-await': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
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
