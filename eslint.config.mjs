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
      // 死代码会无声累积：规则关着的时候，被删掉的功能留下的导入、改签名后
      // 遗留的参数、写了却没接上的 handler，全都不会有人发现。启用为 error 并
      // 承认 `_` 前缀约定（代码里已有大量这种主动标记）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Legacy inline `eslint-disable-next-line react-hooks/exhaustive-deps` comments exist
      // in the codebase; registering the plugin (rule off) resolves "rule not found" errors.
      'react-hooks/exhaustive-deps': 'off',
      // rules-of-hooks 与 exhaustive-deps 不同：后者噪声大、常有误报，前者的每一条命中
      // 都是真 bug —— 条件调用 Hook 会让前后两次渲染的 Hook 数量对不上，React 直接抛
      // “Rendered more hooks than during the previous render”。开启时全仓只有 2 处违规
      // （collab-admin App.tsx 的两个 useMemo 落在 early return 之后），已一并修掉。
      'react-hooks/rules-of-hooks': 'error',
      // Basic best-practice error rules that catch genuine bugs.
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  }
);
