FROM node:22-slim AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/admin-web/package.json ./apps/admin-web/package.json
RUN pnpm install --filter @fin-hub/admin-web... --frozen-lockfile=false

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/admin-web/node_modules ./apps/admin-web/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/admin-web ./apps/admin-web
RUN pnpm --filter @fin-hub/admin-web build

FROM node:22-slim AS runner
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@fin-hub/admin-web", "start"]
