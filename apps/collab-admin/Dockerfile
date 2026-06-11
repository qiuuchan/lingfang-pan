FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG VITE_COLLAB_API_BASE=http://localhost:3000
ENV VITE_COLLAB_API_BASE=$VITE_COLLAB_API_BASE
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab-admin/package.json apps/collab-admin/package.json
RUN pnpm install --filter @lingfang/collab-admin... --frozen-lockfile
COPY apps/collab-admin apps/collab-admin
RUN pnpm -C apps/collab-admin build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/collab-admin/package.json ./apps/collab-admin/package.json
COPY --from=build /app/apps/collab-admin/dist ./apps/collab-admin/dist
EXPOSE 4174
CMD ["pnpm", "-C", "apps/collab-admin", "preview"]