# 附件与凭证归档实现说明

生成时间：2026-08-29

## 1. 目标

本阶段补齐支出凭证归档的基础闭环：

- 支出明细可上传凭证文件。
- 凭证文件落入服务端文件存储目录。
- 附件元数据落库，可按业务资源查询。
- 后台可查看支出凭证列表并下载已归档文件。
- 钉钉真实同步可把表单中的凭证字段记录为附件占位。
- 钉钉占位凭证可手动触发归档下载。

当前支持的上传资源为 `expense_item`。表结构使用 `resource_type/resource_id`，后续可扩展到审批实例、银行流水、报表导出等资源。

## 2. 数据表

新增：

- `attachments`

迁移文件：

- `apps/api/alembic/versions/20260829_0011_attachments.py`

关键字段：

- `resource_type`、`resource_id`：附件归属资源。
- `file_name`、`content_type`、`file_size`、`file_hash`：文件元数据。
- `file_path`：相对 `FILE_STORAGE_ROOT/attachments` 的存储路径。
- `source`：`manual` 或 `dingtalk`。
- `external_file_id`：钉钉文件 ID、图片 URL 或外部文件标识。
- `download_status`：`stored`、`placeholder`、`failed`。

## 3. API

路由前缀：`/api/attachments`

接口：

- `GET /api/attachments`
- `POST /api/attachments?resource_type=expense_item&resource_id={id}`
- `GET /api/attachments/{attachment_id}/download`
- `POST /api/attachments/{attachment_id}/download-dingtalk`

约束：

- 上传目前只支持 `expense_item`。
- 已封账账套下的支出不允许上传新凭证。
- 空文件拒绝上传。
- 下载只允许 `download_status=stored` 且本地文件存在的附件。
- 钉钉归档支持直接 URL 和 `{spaceId,fileId}` 钉盘对象。
- 钉盘对象会先调用钉钉 Drive 下载信息接口换取临时下载 URL。
- 上传会记录审计日志 `attachment.upload`。
- 钉钉归档会记录审计日志 `attachment.dingtalk_download`。

## 4. 后台页面

页面：

- `/expenses`

新增能力：

- 支出行增加“凭证”入口。
- 凭证弹窗展示文件名、来源、状态、大小和下载操作。
- 支持选择文件并上传到当前支出。
- 钉钉占位凭证显示为“待下载”，可点击“归档”下载到本地文件存储。

## 5. 钉钉同步

真实审批同步会读取字段映射中的：

- `voucher_images`
- `voucher_files`

当同步成功生成 `expense_items` 时，系统会把这些字段中的文件 URL、文件 ID 或文件对象记录为 `source=dingtalk` 的附件占位。

## 6. 后续建议

1. 将钉钉附件归档改为后台异步任务和批量重试。
2. 图片类凭证生成缩略图。
3. 支持审批实例详情页集中查看原始表单和凭证。
4. 增加附件删除/作废审计，而不是物理删除。
5. 将本地文件存储抽象为 S3/OSS 兼容接口。
