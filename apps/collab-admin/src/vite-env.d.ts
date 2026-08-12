/// <reference types="vite/client" />

// vite.config define 注入的 git commit 信息（构建时取当前 HEAD）。
declare const __GIT_COMMIT__: string;
declare const __GIT_DATE__: string;

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
