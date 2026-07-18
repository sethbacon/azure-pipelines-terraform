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
        // Per-file floors (issue #590): the GLOBAL average above can hide a
        // security-sensitive file sitting near 0% behind well-covered siblings.
        // These two are the untrusted-input choke points — digest-model.ts parses
        // an attacker-influenced attachment (DoS caps, prototype-pollution guard),
        // ansi-to-html.ts feeds the raw-fallback view (an XSS surface if escaping
        // regresses) — so they get an explicit floor instead of relying on the
        // blend. Actual coverage on main is 98.03/93.3/100/100 (digest-model.ts)
        // and 100/100/100/100 (ansi-to-html.ts); floors below keep a few points of
        // headroom, same rationale as the global entry above.
        './src/tab/digest-model.ts': {
            statements: 95,
            branches: 90,
            functions: 95,
            lines: 95,
        },
        './src/tab/ansi-to-html.ts': {
            statements: 95,
            branches: 90,
            functions: 95,
            lines: 95,
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
