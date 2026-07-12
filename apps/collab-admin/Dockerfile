FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG VITE_COLLAB_API_BASE=
ARG VITE_CDN_BASE_URL=
ENV VITE_COLLAB_API_BASE=$VITE_COLLAB_API_BASE
ENV VITE_CDN_BASE_URL=$VITE_CDN_BASE_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab-admin/package.json apps/collab-admin/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter @lingfang/collab-admin... --no-frozen-lockfile
COPY packages/contract packages/contract
COPY apps/collab-admin apps/collab-admin
RUN pnpm -C apps/collab-admin build

FROM nginx:1.27-alpine
COPY apps/collab-admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/collab-admin/dist /usr/share/nginx/html
EXPOSE 19005
