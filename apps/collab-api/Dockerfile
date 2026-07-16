FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/collab-api/package.json apps/collab-api/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/workflow-engine/package.json packages/workflow-engine/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter @lingfang/collab-api... --no-frozen-lockfile
COPY packages/contract packages/contract
COPY packages/workflow-engine packages/workflow-engine
COPY apps/collab-api apps/collab-api
RUN pnpm -C apps/collab-api prisma:generate && pnpm -C apps/collab-api build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/collab-api ./apps/collab-api
EXPOSE 19006
CMD ["node", "apps/collab-api/dist/main.js"]