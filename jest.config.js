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
            statements: 75,
            branches: 60,
            functions: 50,
            lines: 75,
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
