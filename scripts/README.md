# 脚本说明

## 本地开发

### `dev.sh`

一键启动本地 API 和后台：

```bash
scripts/dev.sh
```

也可以使用：

```bash
pnpm dev
```

脚本会执行：

- 启动 API 到 `http://localhost:8000`。
- 启动后台到 `http://localhost:3000`。
- 输出日志到 `/tmp/fin-hub-api.log` 和 `/tmp/fin-hub-admin-web.log`。

### `dev-api-postgres.sh`

启动本地 PostgreSQL 版 API：

```bash
scripts/dev-api-postgres.sh
```

脚本会执行：

- 通过 Docker Compose 启动 PostgreSQL 和 Redis，除非设置 `START_DOCKER_INFRA=false`。
- 创建 `apps/api/.venv`，如果尚不存在。
- 安装 API 依赖。
- 执行 Alembic 迁移。
- 写入开发样例数据。
- 启动 `uvicorn` 到 `http://localhost:8000`。

默认数据库连接：

```text
postgresql+psycopg://finhub:finhub@localhost:5432/finhub
```

可通过 `DATABASE_URL` 覆盖。

## 生产部署

### 推荐：`build-prod-images.sh` + `deploy-prod-images.sh`

生产环境推荐使用预构建镜像发布，不在服务器上执行 `docker compose build`。这样服务器只做 `docker load` / `docker pull` 和容器重启，避免 Next.js 构建、TypeScript 检查、依赖下载把线上机器资源打满。

本地或 CI 构建并导出镜像包：

```bash
scripts/build-prod-images.sh --save
```

把镜像包和镜像变量文件上传到服务器：

```bash
scp reports/deploy/fin-hub-images-<tag>.tar fin-hub-server:/opt/fin-hub/
scp reports/deploy/fin-hub-images-<tag>.env fin-hub-server:/opt/fin-hub/
```

服务器加载镜像并重启：

```bash
ssh fin-hub-server 'cd /opt/fin-hub && scripts/deploy-prod-images.sh --load fin-hub-images-<tag>.tar --image-env fin-hub-images-<tag>.env'
```

如果已经配置镜像仓库，可以改为：

```bash
scripts/build-prod-images.sh --registry ghcr.io/example/fin-hub --push
ssh fin-hub-server 'cd /opt/fin-hub && scripts/deploy-prod-images.sh'
```

此时 `.env.production` 需要设置：

```text
IMAGE_TAG=<tag>
API_IMAGE=ghcr.io/example/fin-hub/fin-hub-api:<tag>
ADMIN_WEB_IMAGE=ghcr.io/example/fin-hub/fin-hub-admin-web:<tag>
```

### 兼容：`deploy-prod.sh`

`deploy-prod.sh` 会在服务器上构建镜像并启动生产环境。该方式对 CPU、内存和磁盘 I/O 压力较大，仅建议在服务器资源充足或临时排障时使用。

## 交付验收

### `preflight.sh`

运行上线前本地验收：

```bash
scripts/preflight.sh
```

脚本会执行：

- 检查 `pnpm`、`curl`、`node`、`docker`、`uv`。
- 启动 PostgreSQL 和 Redis。
- 安装 API 依赖。
- 执行 Alembic 迁移。
- 运行 API 全量测试和 ruff。
- 安装前端 workspace 依赖。
- 运行后台和小程序 typecheck。
- 构建后台管理端。
- 构建股东小程序 weapp 产物。

可选参数：

- `--smoke`：额外检查已启动的 API、后台登录页、管理员登录和 `/api/system/readiness`。
- `--skip-admin-build`：跳过后台生产构建。
- `--skip-miniapp-build`：跳过小程序构建。

常用快速检查：

```bash
scripts/preflight.sh --skip-admin-build --skip-miniapp-build --smoke
```

## 诊断排障

### `clean-admin-next-artifacts.sh`

清理后台 Next.js 生成物和历史备份目录：

```bash
scripts/clean-admin-next-artifacts.sh
```

清理范围仅限：

- `apps/admin-web/.next`
- `apps/admin-web/.next.bak-*`
- `apps/admin-web/.next-build-backup-*`

这些路径已经在 `.gitignore` 中忽略。执行清理前应先停止后台 dev server，清理后重新启动 `pnpm --filter @fin-hub/admin-web dev`。

### `export-diagnostics.sh`

导出脱敏诊断包：

```bash
scripts/export-diagnostics.sh
```

默认输出：

```text
reports/diagnostics/fin-hub-diagnostics-YYYYMMDDHHMMSS.tar.gz
```

采集内容：

- 系统时间、项目路径、API / 后台地址。
- Git 分支和工作区状态。
- 主要工具版本。
- 项目 package / pyproject 配置。
- Alembic 当前版本、heads 和迁移历史。
- API 健康接口、后台登录页和 OpenAPI 摘要。
- `/tmp/fin-hub-api.log` 和 `/tmp/fin-hub-admin-web.log` 最近 200 行。
- `8000`、`3000` 端口监听状态。

脚本会对常见密钥字段做脱敏，包括 `SECRET_KEY`、`DINGTALK_APP_SECRET`、`DATABASE_URL`、`REDIS_URL`、`POSTGRES_PASSWORD`、`token`、`authorization`、`password` 和 `access_code`。

## 后续可补

- 旧系统数据迁移脚本。
