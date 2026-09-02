# 交付验收与发布检查

生成时间：2026-08-29

## 一键验收脚本

入口：

```bash
scripts/preflight.sh
```

默认检查：

- 本地工具链：`pnpm`、`curl`、`node`、`uv`。
- API 依赖安装。
- Alembic 数据库迁移。
- API 全量测试。
- API ruff 检查。
- 后台管理端 typecheck 和生产构建。
- 股东小程序 typecheck 和 weapp 构建。

可选 HTTP 冒烟：

```bash
scripts/preflight.sh --smoke
```

`--smoke` 依赖已启动的服务：

- `API_BASE_URL`，默认 `http://localhost:8000`。
- `ADMIN_BASE_URL`，默认 `http://localhost:3000`。

冒烟检查：

- `GET /api/health`
- 后台 `/login`
- 管理员 `admin / admin123456` 登录
- `GET /api/system/readiness`

快速检查：

```bash
scripts/preflight.sh --skip-admin-build --skip-miniapp-build --smoke
```

## 发布前人工确认

- 生产环境 `APP_ENV=production`。
- 生产环境不能使用默认 `SECRET_KEY`，长度至少 32 位。
- 生产环境 `CORS_ORIGINS` 不包含 localhost。
- 系统数据库统一使用 PostgreSQL。
- 钉钉正式同步前设置 `DINGTALK_SYNC_MODE=real`，并配置 App Key、App Secret、钉盘 Union ID。
- `NEXT_PUBLIC_API_BASE_URL` 指向正式 API 域名。
- `TARO_APP_API_BASE_URL` 指向微信小程序合法 HTTPS 域名。
- 微信公众平台已配置 request 合法域名。
- 后台管理员默认密码已修改。
- 股东授权码已设置合理到期时间。

## 诊断包

上线后排障可导出脱敏诊断包：

```bash
scripts/export-diagnostics.sh
```

输出目录：

```text
reports/diagnostics/
```

诊断包只采集配置摘要、迁移状态、HTTP 状态、近期本地日志和端口监听信息；不导出数据库文件、附件原件或完整业务数据。脚本会对常见密钥字段做脱敏，但外发前仍应人工检查压缩包内容。
