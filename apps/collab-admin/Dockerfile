FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG VITE_COLLAB_API_BASE=
ARG VITE_CDN_BASE_URL=
ENV VITE_COLLAB_API_BASE=$VITE_COLLAB_API_BASE
ENV VITE_CDN_BASE_URL=$VITE_CDN_BASE_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab-admin/package.json apps/collab-admin/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter @lingfang/collab-admin... --no-frozen-lockfile
COPY apps/collab-admin apps/collab-admin
RUN pnpm -C apps/collab-admin build

FROM node:22-alpine
WORKDIR /app
# 使用 serve 作为轻量静态文件服务器，避免 pnpm workspace 依赖
RUN npm install -g serve
COPY --from=build /app/apps/collab-admin/dist ./dist
EXPOSE 19005
CMD ["serve", "dist", "-l", "19005"]
