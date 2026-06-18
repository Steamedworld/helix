// Flat ESLint config (ESLint 9). Intentionally modest: a bug-catching baseline,
// not a style enforcer. Type-aware rules and stylistic churn are deliberately
// out of scope for this first pass — see docs/PRODUCTION_CONFIG.md.
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/drizzle/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        // Runtime globals used across backend (Node) and frontend (browser).
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        __dirname: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
      },
    },
    rules: {
      // TypeScript's own compiler (pnpm typecheck) owns these — disabling here
      // avoids false positives and large churn from a first-pass lint.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // React hooks correctness for the frontend. First pass keeps both rules as
    // warnings to avoid forcing unrelated product refactors (e.g. a conditional
    // hook in Integrations.tsx and missing-dep arrays). Promote rules-of-hooks
    // to 'error' in a follow-up once those existing findings are resolved.
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
