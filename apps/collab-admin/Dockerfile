FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG VITE_COLLAB_API_BASE=
ENV VITE_COLLAB_API_BASE=$VITE_COLLAB_API_BASE
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab-admin/package.json apps/collab-admin/package.json
RUN pnpm install --filter @lingfang/collab-admin... --no-frozen-lockfile
COPY apps/collab-admin apps/collab-admin
RUN pnpm -C apps/collab-admin build

FROM node:22-alpine
WORKDIR /app
# 使用 serve 作为轻量静态文件服务器，避免 pnpm workspace 依赖
RUN npm install -g serve
COPY --from=build /app/apps/collab-admin/dist ./dist
EXPOSE 4174
CMD ["serve", "dist", "-l", "4174"]
