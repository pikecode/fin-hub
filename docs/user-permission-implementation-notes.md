# 用户、角色与权限管理实现说明

## 背景

当前系统开始引入后台用户权限体系，用于控制用户可以访问哪些功能、可以维护哪些数据，以及财务对账时用户可以处理哪些门店的数据。

权限设计不只做前端菜单隐藏，后端接口也会做权限校验和门店数据范围过滤。

## 权限模型

当前采用三层模型：

1. 用户
2. 角色
3. 功能权限 + 门店权限

角色用于提供默认权限，用户可以再配置具体的功能权限和门店数据范围。

## 角色

当前内置角色：

| 角色 | 说明 |
| --- | --- |
| `admin` | 管理员，拥有全部功能权限和全部门店权限 |
| `finance` | 财务人员，默认拥有对账、报表、门店、分类、钉钉查看、审计查看等常用权限 |
| `viewer` | 只读用户，默认只有查看类权限 |

## 功能权限

当前定义的功能权限：

| 权限 Key | 说明 |
| --- | --- |
| `dashboard.view` | 查看仪表盘 |
| `reconciliation.view` | 查看财务对账 |
| `reconciliation.manage` | 维护财务对账 |
| `dingtalk.view` | 查看钉钉同步数据 |
| `dingtalk.manage` | 维护钉钉同步配置和执行同步 |
| `reports.view` | 查看财务报表 |
| `stores.view` | 查看门店 |
| `stores.manage` | 维护门店 |
| `categories.view` | 查看费用分类 |
| `categories.manage` | 维护费用分类 |
| `users.view` | 查看用户 |
| `users.manage` | 维护用户 |
| `audit.view` | 查看操作日志 |
| `settings.manage` | 维护系统设置 |

## 门店权限

门店权限是数据范围，不是功能开关。

示例：

- 用户有 `stores.view`，并配置了 3 家门店：只能查看这 3 家门店。
- 用户有 `stores.manage`，并配置了 3 家门店：只能维护这 3 家门店。
- 用户有 `reconciliation.view` / `reconciliation.manage`，并配置了 3 家门店：只能查看或处理这 3 家门店的银行流水、审批候选和对账记录。
- 用户没有对应功能权限时，即使配置了门店权限，也不能进入或操作对应模块。

管理员默认拥有全部门店。非管理员需要显式配置门店范围，未配置时不会看到门店范围数据。

## 数据库变更

新增表：

| 表 | 说明 |
| --- | --- |
| `user_permissions` | 用户功能权限 |
| `user_store_permissions` | 用户门店权限 |

用户表新增字段：

| 字段 | 说明 |
| --- | --- |
| `permissions_configured` | 是否已显式配置用户权限 |

相关迁移：

- `apps/api/alembic/versions/20260831_0019_user_permissions.py`
- `apps/api/alembic/versions/20260831_0020_user_permissions_configured.py`

## 后端接入范围

已接入权限控制的模块：

| 模块 | 权限控制 |
| --- | --- |
| 登录态 `/auth/me` | 返回当前用户功能权限和门店范围 |
| 用户管理 | `users.view` / `users.manage` |
| 门店管理 | `stores.view` / `stores.manage` + 门店范围 |
| 银行流水 | `reconciliation.view` / `reconciliation.manage` + 门店范围 |
| 财务对账 | `reconciliation.view` / `reconciliation.manage` + 门店范围 |
| 费用分类 | `categories.view` / `categories.manage` |
| 钉钉同步 | `dingtalk.view` / `dingtalk.manage` |
| 财务报表 | `reports.view` + 门店范围 |
| 操作日志 | `audit.view` |
| 系统设置 | `settings.manage` |

权限核心实现位置：

- `apps/api/app/modules/auth/permissions.py`
- `apps/api/app/modules/auth/router.py`
- `apps/api/app/modules/users/router.py`

## 前端接入范围

用户管理页面已支持：

- 新增用户
- 编辑用户
- 设置角色
- 设置功能权限
- 设置可管理门店
- 查看用户权限数量和门店范围

导航菜单已根据 `/auth/me` 返回的权限动态过滤。

相关文件：

- `apps/admin-web/app/users/page.tsx`
- `apps/admin-web/app/components/ProLayout.tsx`
- `packages/shared-types/src/index.ts`

## 当前行为说明

权限计算规则：

- `admin`：始终返回全部功能权限和全部门店。
- 非管理员：
  - 如果用户已显式配置功能权限，则使用用户配置。
  - 如果用户未显式配置功能权限，则使用角色默认权限。
  - 门店权限必须显式配置，未配置时没有门店数据范围。

这能区分两种情况：

- 用户还没配置过权限：按角色默认权限处理。
- 用户明确配置为空权限：不再回退到角色默认权限。

## 验证结果

已执行：

```bash
uv run pytest
pnpm --filter @fin-hub/admin-web typecheck
git diff --check
```

结果：

- 后端测试：`89 passed`
- 前端类型检查：通过
- diff 空白检查：通过

## 后续建议

下一步可以继续完善：

- 增加角色管理页面，让角色默认权限可配置。
- 增加权限变更审计详情，记录权限前后差异。
- 在更多页面按钮层面做权限隐藏，例如无维护权限时隐藏新增、编辑、同步按钮。
- 为报表、对账、钉钉同步补更细粒度的接口测试。
