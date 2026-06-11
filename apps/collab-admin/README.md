# Collab Admin

平台管理员网页管理端。普通用户和团队管理员不使用该入口。

## 本地开发

API 默认地址为 `http://localhost:3000`。推荐显式指定：

```bash
VITE_API_BASE_URL=http://localhost:3000 pnpm -C apps/collab-admin dev
```

默认访问：`http://localhost:4174`

## 环境变量

优先读取：

```env
VITE_API_BASE_URL=http://localhost:3000
```

兼容旧变量名：

```env
VITE_COLLAB_API_BASE=http://localhost:3000
```

## 构建

```bash
pnpm -C apps/collab-admin typecheck
VITE_API_BASE_URL=http://localhost:3000 pnpm -C apps/collab-admin build
pnpm -C apps/collab-admin preview
```