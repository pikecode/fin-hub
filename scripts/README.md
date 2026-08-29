# 脚本说明

## 本地开发

### `dev-api-sqlite.sh`

启动本地 SQLite 版 API：

```bash
scripts/dev-api-sqlite.sh
```

脚本会执行：

- 创建 `apps/api/.venv`，如果尚不存在。
- 安装 API 依赖。
- 执行 Alembic 迁移。
- 写入开发样例数据。
- 启动 `uvicorn` 到 `http://localhost:8000`。

默认数据库：

```text
apps/api/data/dev.db
```

可通过 `DATABASE_URL` 覆盖。

## 交付验收

### `preflight.sh`

运行上线前本地验收：

```bash
scripts/preflight.sh
```

脚本会执行：

- 检查 `pnpm`、`curl`、`node`、`uv`。
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

## 后续可补

- 旧 SQLite 数据迁移脚本。
- 脱敏诊断包导出脚本。
