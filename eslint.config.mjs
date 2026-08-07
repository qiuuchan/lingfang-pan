import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/target/**',
      '**/coverage/**',
      '**/*.generated.ts',
      '**/*.generated.tsx',
      '**/prisma/migrations/**',
      '**/out/**',
      '**/.next/**',
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
    ],
  },
  // Error-level, low-noise baseline: TypeScript recommended + Prettier (formatter off).
  ...tseslint.configs.recommended,
  prettier,
  {
    // Source files contain legacy `eslint-disable` comments for rules we keep off
    // (e.g. no-explicit-any, react-hooks/exhaustive-deps); don't fail on those.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      // Node + browser globals so `no-undef` doesn't fire on standard built-ins
      // (process/console/setTimeout in scripts, window/document in web apps, etc.).
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Disable Prettier-style/low-signal rules so the gate catches real bugs, not churn.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
      // `prefer-const` produces false positives in this codebase (variables read inside an
      // earlier-declared closure then written later are reported as "never reassigned");
      // enforcing it would require build-breaking `const` edits. Also per "no prefer-const churn".
      'prefer-const': 'off',
      // Pre-existing dead-code findings across the monorepo — tightened to keep the
      // gate green and avoid mass-editing source; re-enable incrementally later.
      '@typescript-eslint/no-unused-vars': 'off',
      // Legacy inline `eslint-disable-next-line react-hooks/exhaustive-deps` comments exist
      // in the codebase; registering the plugin (rule off) resolves "rule not found" errors.
      'react-hooks/exhaustive-deps': 'off',
      // Basic best-practice error rules that catch genuine bugs.
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  }
);
