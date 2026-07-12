/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src/tab'],
    testMatch: ['**/*.test.ts', '**/*.test.tsx'],
    moduleNameMapper: {
        '\\.css$': '<rootDir>/src/tab/__mocks__/styleMock.js',
    },
    collectCoverage: true,
    collectCoverageFrom: [
        'src/tab/**/*.{ts,tsx}',
        '!src/tab/**/*.test.{ts,tsx}',
        '!src/tab/index.html',
    ],
    coverageThreshold: {
        global: {
            // Raised from 70/58/42/70 after adding tests for the previously-untested
            // render branches (loading/error/empty states, multi-plan <select>,
            // oversize-plan download link) and loadPlans edge cases (no attachments,
            // per-attachment fetch failure, top-level failure). Actual coverage is
            // ~82/81/63/83; a few points of headroom is kept below that so a small,
            // legitimate code change doesn't fail the gate. The module-level SDK
            // bootstrap block (SDK.ready().then(...) wiring) stays uncovered by
            // design — it needs a real DOM (jsdom), see tabContent.test.tsx.
            statements: 80,
            branches: 78,
            functions: 60,
            lines: 80,
        },
    },
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: {
                module: 'commonjs',
                moduleResolution: 'node',
                target: 'es6',
                jsx: 'react',
                lib: ['es6', 'dom'],
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
            },
        }],
    },
};
