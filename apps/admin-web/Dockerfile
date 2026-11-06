ARG NODE_BASE_IMAGE=node:22-slim
FROM ${NODE_BASE_IMAGE} AS deps
WORKDIR /repo
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN corepack enable
RUN pnpm config set registry https://registry.npmmirror.com

# 复制 lock 文件优先（变化少，缓存效果好）
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# 复制 package.json 文件用于依赖安装
COPY packages ./packages
COPY apps/admin-web/package.json ./apps/admin-web/package.json
RUN pnpm install --filter @fin-hub/admin-web... --frozen-lockfile

FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /repo
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1

# 只复制已编译的 node_modules
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/admin-web/node_modules ./apps/admin-web/node_modules

# 再复制代码（代码变化频繁，但利用前面的缓存）
COPY package.json pnpm-workspace.yaml ./
COPY apps/admin-web ./apps/admin-web
RUN pnpm --filter @fin-hub/admin-web build

# Always start the runtime from Node, never from a previous application image.
FROM node:22-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /repo/apps/admin-web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/admin-web/.next/static ./apps/admin-web/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/admin-web/server.js"]
