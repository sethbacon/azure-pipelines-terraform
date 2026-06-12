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
        },
    },
    {
        ignores: ['Tests/**', 'node_modules/**', '**/*.js', '**/*.mjs'],
    }
);
