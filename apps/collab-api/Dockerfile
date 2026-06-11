FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab-api/package.json apps/collab-api/package.json
RUN pnpm install --filter @lingfang/collab-api... --frozen-lockfile
COPY apps/collab-api apps/collab-api
RUN pnpm -C apps/collab-api prisma:generate && pnpm -C apps/collab-api build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/collab-api ./apps/collab-api
EXPOSE 3000
CMD ["pnpm", "-C", "apps/collab-api", "start"]