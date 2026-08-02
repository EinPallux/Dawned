// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'assets/**',
      'assets_baked/**',
      'packages/client/public/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level config files live outside the composite projects.
          allowDefaultProject: ['*.ts', '*.js', 'packages/*/vite.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The project bans `any` (CLAUDE.md): unknown + narrowing instead.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // Server and shared code runs on Node.
    files: ['packages/server/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Client code runs in the browser.
    files: ['packages/client/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Tooling scripts and build config: plain ESM, outside the composite projects,
    // so type-aware rules are off. Smoke tests contain browser-context callbacks
    // (page.evaluate), hence both global sets.
    files: ['**/*.mjs', '**/*.js', '*.config.ts', 'packages/*/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        // Must be explicit: the block above enables projectService globally.
        projectService: false,
        project: false,
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-undef': 'error',
    },
  },
  prettier,
);
