# 系统设置与数据库备份实现说明

更新时间：2026-08-29

## 后台页面

页面：

- `/settings`

已实现能力：

- 查看后台 API 地址和当前运行环境。
- 查看后台登录方式和股东访问方式。
- 查看钉钉 Corp ID、App Key、App Secret 配置状态。
- 查看管理员 User ID、钉盘 Union ID、同步状态。
- 查看数据库类型和备份能力。
- 展示 PostgreSQL 备份策略。
- 展示 API、生产就绪状态、钉钉配置、文件存储、密钥、跨域和数据库等交付检查项。

## API

路由前缀：

- `/api/system`

接口：

- `GET /api/system/readiness`
- `GET /api/system/database-backup/status`
- `GET /api/system/database-backup/download`：保留兼容入口，统一返回 409 并提示使用 PostgreSQL 原生备份。

权限：

- 仅 `admin` 角色可访问。

## 生产就绪检查

`readiness` 返回：

- `environment`：后端 `APP_ENV`。
- `ready`：没有 `error` 级检查项时为 `true`。
- `checks`：检查项列表，状态为 `ok`、`warning` 或 `error`。

当前检查项：

- 数据库：非 PostgreSQL 为阻断项。
- 服务端密钥：`SECRET_KEY` 使用默认值或长度小于 32 为阻断项。
- 跨域来源：生产环境 `CORS_ORIGINS` 包含 localhost 为阻断项。
- 文件存储：`FILE_STORAGE_ROOT` 父目录不存在为阻断项。
- 钉钉同步：`mock` 模式为提醒项；`real` 模式缺少 App Key 或 App Secret 为阻断项。

## 数据库备份策略

当前支持：

- 展示 PostgreSQL 数据库类型。
- 提示使用 `pg_dump`、托管数据库快照或云厂商备份策略。

当前不支持：

- 后台直连导出数据库。
- 在应用进程内生成数据库备份文件。

PostgreSQL 生产环境建议：

- 使用 `pg_dump`、托管数据库快照或云厂商备份策略。
- 后台只展示“需外部备份”，避免提供不完整或不一致的导出。

## 安全约定

- 备份文件包含完整业务数据和配置数据，不应外传。
- 钉钉 App Secret 不在后台页面和 API 响应中回显。
- 生产环境应使用服务端环境变量或 KMS/Secret Manager 保存密钥。
- 数据库备份状态和兼容下载入口需要后台管理员登录态。
