# 蘑说财务管理系统 API 与密钥配置汇总

生成时间：2026-08-28

> 安全说明：本文档只记录密钥是否存在、用途、来源和脱敏值，不记录完整 `appSecret`、`accessToken` 等敏感明文。当前数据库中存在完整钉钉应用密钥，`data/` 目录不应外传。

## 1. 总览

当前系统的外部 API 主要集中在 `app/dingtalk/` 包内：

- 钉钉开放平台 OAuth2：获取 `accessToken`
- 钉钉开放平台 Workflow：拉取审批模板、审批实例 ID、审批实例详情
- 钉钉开放平台 Drive：通过钉盘 `spaceId/fileId` 换取临时下载地址
- 钉钉图片 CDN：下载 `DDPhotoField` 图片直链

未发现其他业务模块直接调用第三方网络 API。业务数据存储在本地 SQLite，报表导出为本地 HTML 文件。

## 2. API 清单

| 模块 | API/能力 | SDK/调用方式 | 代码位置 | 鉴权方式 | 用途 |
|---|---|---|---|---|---|
| OAuth2 | 获取 accessToken | `OAuth2Client.get_access_token` | `app/dingtalk/client.py` | `appKey + appSecret` | 获取钉钉访问令牌，并写入本地缓存 |
| Workflow | 审批模板列表 | `WorkflowClient.list_user_visible_bpms_processes_with_options` | `app/dingtalk/client.py` | Header: `x-acs-dingtalk-access-token` | 拉取当前应用/用户可见的 OA 审批模板 |
| Workflow | 审批实例 ID 列表 | `WorkflowClient.list_process_instance_ids_with_options` | `app/dingtalk/client.py` | Header: `x-acs-dingtalk-access-token` | 按模板和时间窗口增量查询审批实例 |
| Workflow | 审批实例详情 | `WorkflowClient.get_process_instance_with_options` | `app/dingtalk/client.py` | Header: `x-acs-dingtalk-access-token` | 获取审批单表单字段、状态、发起部门等详情 |
| Drive | 钉盘下载信息 | `DriveClient.get_download_info_with_options` | `app/dingtalk/attachment.py` | Header: `x-acs-dingtalk-access-token` + `unionId` | 通过 `spaceId/fileId` 换临时下载链接 |
| HTTP | 图片直链下载 | `requests.Session.get` | `app/dingtalk/attachment.py` | 无 | 下载钉钉图片字段中的 `static.dingtalk.com` 图片 |
| HTTP | 钉盘临时链接下载 | `requests.Session.get` | `app/dingtalk/attachment.py` | 临时 URL | 下载 Drive API 返回的文件资源 |

## 3. 钉钉 API 调用链

### 3.1 凭证保存与读取

- 配置入口：`app/services/dingtalk_service.py`
- 底层存储：`system_config` 表
- 配置键：
  - `dingtalk_app_key`
  - `dingtalk_app_secret`
  - `dingtalk_admin_user_id`
  - `dingtalk_token_cache`
  - `dingtalk_last_template_sync`
  - `dingtalk_drive_union_id`

启动时还有一个备用导入通道：

- 文件路径：`data/dingtalk_config.json`
- 读取位置：`main.py` 调用 `import_dingtalk_config_file`
- 当前状态：未发现该文件，系统实际以数据库 `system_config` 为准
- 文件格式预期：

```json
{
  "appKey": "钉钉应用 AppKey",
  "appSecret": "钉钉应用 AppSecret"
}
```

### 3.2 Token 获取

调用位置：`app/dingtalk/client.py`

流程：

1. 优先使用进程内 token 缓存。
2. 进程内没有时，读取 `system_config.dingtalk_token_cache`。
3. token 剩余有效期小于 300 秒时刷新。
4. 调用钉钉 OAuth2 `get_access_token`。
5. 新 token 写回 `system_config.dingtalk_token_cache`。

机制：

- 请求间隔限制：最少 150ms
- 限流退避：1s、2s、4s
- 401/token 失效时：强制刷新 token 后重试一次

### 3.3 审批模板同步

调用位置：

- `app/services/dingtalk_service.py`
- `app/dingtalk/template_sync.py`
- `app/dingtalk/client.py`

使用 API：

- `list_user_visible_bpms_processes_with_options`

参数要点：

- `max_results = 100`
- `next_token` 首次传 `"0"`
- 可选 `user_id`：来自 `dingtalk_admin_user_id`

落库位置：

- `approval_templates`
- `template_field_mappings`

### 3.4 审批实例同步

调用位置：

- `app/dingtalk/sync_worker.py`
- `app/dingtalk/instance_sync.py`
- `app/dingtalk/client.py`

使用 API：

- `list_process_instance_ids_with_options`
- `get_process_instance_with_options`

同步规则：

- 每个模板独立同步。
- 查询窗口最多 120 天，系统内部切为 119 天片段。
- 使用 24 小时重叠水位，避免边界漏单。
- 实例列表按 `statuses=["COMPLETED"]` 预过滤。
- 详情层再次校验 `status=COMPLETED` 且 `result=agree`。
- `instance_id` 作为唯一键，重复同步不重复插入。

落库位置：

- `reimbursements`
- `reimbursement_custom_values`
- `attachments`

### 3.5 凭证下载

调用位置：`app/dingtalk/attachment.py`

图片凭证：

- 来源：钉钉 `DDPhotoField`
- 方式：直接 HTTP GET 图片 URL
- 鉴权：无
- 并发：最多 3 路
- 落盘：`data/vouchers/{YYYY}/{MM}/`
- 缩略图：`data/thumbnails/{YYYY}/{MM}/`

钉盘附件：

- 来源：钉钉 `DDAttachment`
- 关键字段：`spaceId`、`fileId`
- 方式：
  1. 调用 Drive API 获取临时下载地址。
  2. 使用 HTTP GET 下载临时地址。
- 额外配置：`dingtalk_drive_union_id`
- 权限要求：`Drive.DownloadInfo.Read`
- 当前代码策略：权限未开通或配置不足时降级为占位，不阻断审批单同步。

## 4. 当前密钥与配置状态

数据来源：`data/moshuo.db` 的 `system_config` 表。

| 配置键 | 当前状态 | 脱敏值 | 用途 | 更新时间 |
|---|---|---|---|---|
| `dingtalk_app_key` | 已配置 | `dingmc...tnuf` | 钉钉应用 AppKey | 2026-08-22 06:51:28 |
| `dingtalk_app_secret` | 已配置 | `73aJD5...2fD3` | 钉钉应用 AppSecret | 2026-08-22 06:51:28 |
| `dingtalk_admin_user_id` | 未配置/空值 | 空 | 拉取指定用户可见审批模板，可选 | 2026-08-22 06:51:28 |
| `dingtalk_drive_union_id` | 已配置 | `qxuEiS...iEiE` | 钉盘下载操作人 unionId，说明为“胡可明” | 2026-08-22 07:04:08 |
| `dingtalk_last_template_sync` | 已配置 | `2026-08-22 06:51:29` | 上次刷新模板时间 | 2026-08-22 06:51:29 |
| `dingtalk_token_cache` | 已配置但已过期 | `token=b70ddf...1144, expire_at=1787359889` | accessToken 本地缓存 | 2026-08-22 06:51:29 |

`dingtalk_token_cache.expire_at=1787359889` 对应本地时间 `2026-08-22 08:51:29 CST`。截至 2026-08-28，该缓存 token 已过期；下次调用钉钉 API 时会自动刷新。

## 5. 配置来源优先级

当前系统有两种钉钉凭证配置来源：

1. 数据库 `system_config`
2. 文件 `data/dingtalk_config.json`

优先级规则：

- 如果数据库已有 `appKey/appSecret`，启动时不会覆盖，数据库优先。
- 只有当数据库凭证为空，并且 `data/dingtalk_config.json` 同时存在完整 `appKey/appSecret` 时，才会从文件导入。
- 当前未发现 `data/dingtalk_config.json`，因此实际使用数据库配置。

## 6. 安全观察

当前已有的安全措施：

- UI 回显时 `appKey` 半遮罩、`appSecret` 全遮罩。
- 日志过滤器会脱敏 `appSecret`、`accessToken`、`token`、`secret`、`password` 等字段。
- 凭证不写入报表。
- 图片/附件落本地 `data/` 目录。

主要风险：

- `system_config` 里的 `dingtalk_app_secret` 是明文存储，没有数据库级加密。
- `dingtalk_token_cache` 也是明文 JSON 存储。
- `data/moshuo.db`、`data/moshuo.db-wal`、`data/moshuo.db-shm` 都可能包含敏感配置或财务数据。
- `data/` 目录不应提交 Git、不应通过聊天工具或邮件外传。
- 当前 `data/dingtalk_config.json` 虽不存在，但如果后续创建，也会包含明文密钥，应加入备份/传输管控。

## 7. 建议

短期：

- 不要把 `data/` 目录打包给第三方，除非先清理或脱敏数据库。
- 如果这份项目目录曾被外传，建议在钉钉开放平台重置 AppSecret。
- 导出给开发人员时，提供结构化测试库，不提供真实 `moshuo.db`。

中期：

- 对 `dingtalk_app_secret` 做本机加密存储，例如 Windows Credential Manager 或 DPAPI。
- token 缓存只存短期 token，并允许一键清除。
- 增加“导出诊断包”功能，自动排除 `system_config` 敏感键和凭证文件。

新版 Web 系统：

- 不应沿用明文 SQLite 配置方式。
- 密钥应放在服务端环境变量或云厂商 KMS/Secret Manager。
- 操作日志不要记录请求 header、token、appSecret、下载 URL。
