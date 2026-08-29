# 钉钉模板与字段映射第一阶段实现说明

生成时间：2026-08-29

## 1. 本阶段目标

本阶段先完成钉钉审批接入的前置配置能力：

- 审批模板登记。
- 模板同步入口。
- 标准字段与钉钉来源字段映射。
- 后台页面可查看和维护映射。
- 支持钉钉连接测试。
- 支持 `mock` / `real` 两种同步模式。

默认 `DINGTALK_SYNC_MODE=mock`，`同步模板` 会生成开发样例模板，用于本地联调。
配置 `DINGTALK_SYNC_MODE=real` 后，`同步模板` 会调用钉钉 OpenAPI 拉取当前管理员可见的审批模板。

## 2. 数据表

新增：

- `approval_templates`
- `template_field_mappings`

迁移文件：

- `apps/api/alembic/versions/20260829_0003_dingtalk_templates.py`

## 3. API

路由前缀：`/api/dingtalk`

接口：

- `GET /api/dingtalk/templates`
- `POST /api/dingtalk/templates`
- `POST /api/dingtalk/connection-test`
- `POST /api/dingtalk/templates/sync`
- `GET /api/dingtalk/templates/{template_id}/field-candidates`
- `GET /api/dingtalk/templates/{template_id}/mappings`
- `POST /api/dingtalk/templates/{template_id}/mappings`

## 4. 后台页面

页面：

- `/dingtalk`

已支持：

- 查看钉钉应用凭证配置。
- 保存钉钉应用凭证。
- 测试钉钉 OpenAPI 连接。
- 查看审批模板列表。
- mock 模式同步开发样例模板。
- real 模式同步钉钉审批模板。
- 手工新增审批模板。
- 查看模板字段映射。
- 从模板快照和已同步审批实例中提取字段候选。
- 新增或更新标准字段映射。
- 字段映射弹窗支持从候选字段下拉选择，选中后自动带出字段 ID、字段路径和字段类型；没有候选时仍可手工输入。

## 5. 密钥与模式

- `App Secret` 使用 `SECRET_KEY` 派生密钥后加密存储，不在 API 响应中回显。
- 也可以通过环境变量 `DINGTALK_APP_KEY`、`DINGTALK_APP_SECRET` 覆盖数据库配置。
- `DINGTALK_SYNC_MODE=mock`：不访问钉钉，生成开发样例数据。
- `DINGTALK_SYNC_MODE=real`：调用钉钉 token、模板和审批实例接口。
- `DINGTALK_API_BASE_URL` 默认 `https://api.dingtalk.com`。
- `DINGTALK_OAPI_BASE_URL` 默认 `https://oapi.dingtalk.com`。

## 6. 建议标准字段

- `store`
- `expense_date`
- `amount`
- `description`
- `category_l1`
- `category_l2`
- `supplier_name`
- `payee_account`
- `applicant_name`
- `voucher_images`
- `voucher_files`
- `remark`

## 7. 下一步

已补充：

- 审批实例同步任务表。
- 审批实例表。
- 开发模拟同步可生成支出明细。
- 后台可查看同步任务和审批实例。
- 钉钉 OAuth2 token 获取。
- 真实审批模板同步。
- 真实审批实例同步。
- 使用字段映射把审批表单转换成 `expense_items`。
- 解析模板控件结构和审批实例 payload，自动生成候选字段。

下一步：

1. 单实例失败重试。
2. 增量同步水位自动推进。
3. 钉钉接口限流与重试策略。
