FROM node:22-slim AS deps
WORKDIR /repo
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN corepack enable
RUN pnpm config set registry https://registry.npmmirror.com
COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/admin-web/package.json ./apps/admin-web/package.json
RUN pnpm install --filter @fin-hub/admin-web... --frozen-lockfile

FROM node:22-slim AS build
WORKDIR /repo
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN corepack enable
RUN pnpm config set registry https://registry.npmmirror.com
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/admin-web/node_modules ./apps/admin-web/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/admin-web ./apps/admin-web
RUN pnpm --filter @fin-hub/admin-web build

FROM node:22-slim AS runner
WORKDIR /repo
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN corepack enable
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@fin-hub/admin-web", "start"]
