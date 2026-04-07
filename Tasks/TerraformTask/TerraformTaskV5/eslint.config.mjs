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
            '@typescript-eslint/no-unused-vars': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-require-imports': 'off',
            'prefer-const': 'warn',
            'no-var': 'warn',
            'no-extra-semi': 'warn',
        },
    },
    {
        ignores: ['Tests/**', 'node_modules/**', '**/*.js'],
    }
);
