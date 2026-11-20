import globals from 'globals';

const CDN_GLOBALS = {
  XLSX: 'readonly',
  Papa: 'readonly',
  JSZip: 'readonly',
  Fuse: 'readonly',
  TomSelect: 'readonly',
  flatpickr: 'readonly',
  lucide: 'readonly',
  pdfjsLib: 'readonly',
  SettlementProcessor: 'readonly',
  Toast: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'tests/**', 'e2e/**']
  },
  {
    files: ['*.js'],
    ignores: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...CDN_GLOBALS
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      'no-redeclare': 'error',
      'no-dupe-class-members': 'error'
    }
  },
  {
    files: ['sw.js', 'automatcher.worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.serviceworker,
        ...globals.worker
      }
    }
  },
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      'no-redeclare': 'error'
    }
  }
];
