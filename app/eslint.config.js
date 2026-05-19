import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettierConfig from 'eslint-config-prettier';

// Custom rule: disallow em-dash (U+2014) and en-dash (U+2013) in source code
// per user-wide preference. Numeric ranges should be written with "to" or "-".
const noEmDashRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow em-dash and en-dash characters in source code' },
    schema: [],
    messages: {
      noEmDash: 'Em-dash (U+2014) is not allowed. Use a comma, semicolon, colon, period, or parentheses instead.',
      noEnDash: 'En-dash (U+2013) is not allowed. Use a hyphen or rephrase.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      Program() {
        const text = sourceCode.getText();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (let j = 0; j < line.length; j++) {
            const ch = line.charCodeAt(j);
            if (ch === 0x2014) {
              context.report({
                loc: { start: { line: i + 1, column: j }, end: { line: i + 1, column: j + 1 } },
                messageId: 'noEmDash',
              });
            } else if (ch === 0x2013) {
              context.report({
                loc: { start: { line: i + 1, column: j }, end: { line: i + 1, column: j + 1 } },
                messageId: 'noEnDash',
              });
            }
          }
        }
      },
    };
  },
};

const localPlugin = {
  rules: {
    'no-em-dash': noEmDashRule,
  },
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'coverage/**',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        CustomEvent: 'readonly',
        Image: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        // Node-ish globals used in scripts/test config
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      local: localPlugin,
    },
    rules: {
      // typescript-eslint adjustments to fit Justin's loose tsconfig style
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': ['warn', { allowShortCircuit: true, allowTernary: true }],
      // Allow require-style imports if any sneak in (Tauri/Vite ecosystem occasionally needs)
      '@typescript-eslint/no-require-imports': 'off',

      // Base eslint adjustments
      'no-unused-vars': 'off', // handled by typescript-eslint
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'prefer-const': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',

      // React hooks (recommended-style)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Fast Refresh
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Custom no-em-dash rule (Justin's hard rule)
      'local/no-em-dash': 'error',
    },
  },
  {
    // Test files: more permissive
    files: ['tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  // Prettier config LAST to disable any formatting rules that would conflict
  prettierConfig,
);
