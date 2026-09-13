# fin-hub 技术选型与三项目规划

生成时间：2026-08-28

## 1. 结论

本系统建议拆成三个项目：

| 项目 | 名称建议 | 技术栈 | 角色 |
|---|---|---|---|
| 后台管理 | `apps/admin-web` | Next.js + React + TypeScript + Ant Design | 财务人员、总部管理员使用 |
| API 服务 | `apps/api` | FastAPI + SQLAlchemy + PostgreSQL + Alembic | 业务接口、钉钉同步、报表、文件、任务 |
| 微信小程序 | `apps/shareholder-miniapp` | Taro + React + TypeScript | 股东只读查看已封账报表 |

配套基础设施：

| 能力 | 方案 |
|---|---|
| 数据库 | PostgreSQL |
| 后台任务 | Celery + Redis |
| 文件存储 | 本地文件目录起步，抽象 Storage 接口，后续可切对象存储 |
| API 鉴权 | JWT Session / HttpOnly Cookie |
| API 文档 | FastAPI OpenAPI 自动生成 |
| 包管理 | pnpm 管理前端与小程序，uv 或 Poetry 管理 Python |
| 部署 | Docker Compose 起步，后续迁移云服务器 |

## 2. 为什么这样选

### 2.1 API 使用 FastAPI

理由：

- 旧桌面版的钉钉同步、表单解析、附件下载、匹配算法都是 Python 代码，迁移成本最低。
- FastAPI 原生基于 Python 类型提示，接口模型、校验和 OpenAPI 文档生成直接受益。
- 财务系统核心复杂度在数据模型、同步、导入、匹配和报表，不在极高并发。
- 后台任务可用 Celery 承接钉钉同步、附件下载、银行导入、报表导出。

不选 Node/NestJS 的原因：

- NestJS 也适合企业 API，但会导致旧 Python 业务资产重写。
- 钉钉表单解析和历史迁移脚本继续用 Python 更自然。

### 2.2 后台管理使用 Next.js

理由：

- 后台管理需要复杂表格、筛选、弹窗、分步导入、对账工作台，React 生态成熟。
- Next.js App Router 适合组织管理后台的页面路由、布局和服务端能力。
- TypeScript 能提升表单、表格、接口数据结构的稳定性。
- 后端独立为 FastAPI，因此 Next.js 主要做前端应用，不把核心业务写进 Next API Routes。

UI 组件建议：

- Ant Design。

原因：

- 财务后台是高密度操作型系统，Ant Design 的表格、表单、弹窗、步骤条、上传、日期选择、树表格更贴合。
- 旧原型也提到 Vite + React + TypeScript + Ant Design，可延续认知。

### 2.3 小程序使用 Taro

理由：

- 股东端是只读报表，交互复杂度低，但需要和 Web 前端共享 TypeScript 类型、请求封装和部分图表逻辑。
- Taro 支持 React + TypeScript，能降低团队在 Web 与小程序之间的心智切换。
- 后续如果要做 H5 股东报表页，Taro 有一定复用空间。

不选原生微信小程序的原因：

- 原生小程序更贴近平台，但与 React/TypeScript 后台技术栈割裂更大。
- 股东端不是重度原生能力应用，没必要优先牺牲工程一致性。

## 3. 仓库结构建议

采用 monorepo：

```text
fin-hub/
  apps/
    admin-web/
    api/
    shareholder-miniapp/
  packages/
    shared-types/
    shared-api-client/
    shared-utils/
  docs/
  infra/
    docker/
    nginx/
  scripts/
```

说明：

- `apps/admin-web`：后台管理前端。
- `apps/api`：FastAPI 后端。
- `apps/shareholder-miniapp`：微信小程序。
- `packages/shared-types`：接口 DTO、枚举、状态类型，前端和小程序共享。
- `packages/shared-api-client`：请求客户端封装。
- `infra`：Docker Compose、Nginx、部署配置。
- `scripts`：历史数据迁移、初始化、诊断脚本。

## 4. API 项目规划

### 4.1 后端技术栈

建议：

- Python 3.12+
- FastAPI
- Pydantic v2
- SQLAlchemy 2.x
- Alembic
- PostgreSQL
- Celery
- Redis
- pytest
- ruff
- mypy 或 pyright

### 4.2 后端模块

```text
apps/api/app/
  main.py
  core/
    config.py
    security.py
    database.py
    logging.py
  modules/
    auth/
    stores/
    ledgers/
    dingtalk/
    expense/
    bank/
    revenue/
    matching/
    categories/
    suppliers/
    reports/
    files/
    audit/
    tasks/
  workers/
  migrations/
  tests/
```

### 4.3 后端边界

API 必须承载业务真源：

- 封账写入拦截在 API 层统一执行。
- 匹配确认在事务中完成。
- 金额和状态派生在后端完成。
- 操作日志由后端统一写入。
- 前端不能直接推导关键财务状态。

## 5. 后台管理项目规划

### 5.1 前端技术栈

建议：

- Next.js App Router
- React
- TypeScript
- Ant Design
- TanStack Query
- Zustand
- dayjs
- decimal.js
- echarts 或 AntV

### 5.2 页面结构

```text
apps/admin-web/app/
  login/
  dashboard/
  stores/
  categories/
  suppliers/
  dingtalk/
    config/
    templates/
    templates/[id]/mapping/
  ledgers/
    page.tsx
    [ledgerId]/
      overview/
      revenue/
      bank/
      expenses/
      matching/
      suppliers/
  reports/
  audit-logs/
  settings/
```

### 5.3 交互重点

第一版后台不要做营销式首页，要做可操作工作台：

- 首页展示待办。
- 账套页固定门店和月份上下文。
- 对账工作台左右分栏。
- 银行流水导入使用分步流程。
- 单据管理以支出明细行为主，审批单可展开。
- 封账前显示检查清单。

## 6. 小程序项目规划

### 6.1 小程序技术栈

建议：

- Taro
- React
- TypeScript
- Taro UI 或 NutUI for Taro
- echarts-for-weixin 或 F2

### 6.2 小程序页面

```text
apps/shareholder-miniapp/src/pages/
  login/
  stores/
  report/
  trend/
```

页面：

- 微信登录。
- 授权门店列表。
- 门店月度报表。
- 月份切换。
- 近 N 月趋势。

规则：

- 只读。
- 只展示已封账账套。
- 不暴露未封账过程数据。
- 不暴露凭证原图，除非后续明确授权。

## 7. 数据库策略

使用 PostgreSQL。

关键原因：

- 多表关系复杂，PostgreSQL 更适合长期演进。
- 支持 JSONB 存原始钉钉 payload。
- 支持事务、约束、索引和复杂报表查询。
- 后续做审计、权限、报表聚合比 SQLite 更稳。

金额字段：

- 使用 `NUMERIC(14, 2)` 或更高精度。
- 应用层使用 Decimal。

时间字段：

- 业务日期用 `date`。
- 操作时间用 `timestamptz`。
- 账期统一 `YYYY-MM` 字符串或 `period_month date`，推荐用每月 1 号的 `date`。

## 8. 后台任务策略

需要后台任务的场景：

- 钉钉模板同步。
- 钉钉审批单同步。
- 附件下载。
- 银行流水文件解析。
- 报表导出。
- 旧系统数据迁移。

任务交互：

- API 创建任务返回 `task_id`。
- 前端轮询任务状态。
- 状态支持：pending、running、success、partial_success、failed、cancelled。
- 部分成功必须返回失败明细。

## 9. 部署方案

第一阶段建议 Docker Compose：

```text
nginx
admin-web
api
worker
postgres
redis
storage-volume
```

部署形态：

- 国内云服务器。
- HTTPS 由 Nginx 终止。
- API 和 Admin Web 内网通信。
- 文件通过 API 鉴权后下发。

环境变量：

- `DATABASE_URL`
- `REDIS_URL`
- `SECRET_KEY`
- `DINGTALK_APP_KEY`
- `DINGTALK_APP_SECRET`
- `DINGTALK_DRIVE_UNION_ID`
- `FILE_STORAGE_ROOT`

生产环境不要把钉钉密钥写入前端构建产物。

## 10. 需要立即拍板的问题

技术侧：

- 后端是否确定使用 FastAPI。
- 后台 UI 是否确定使用 Ant Design。
- 小程序是否接受 Taro，而不是微信原生。
- 是否现在就采用 monorepo。
- PostgreSQL 是否作为第一版数据库。
- 是否第一版就引入 Redis/Celery。

业务侧：

- 是否确认权责发生制。
- 是否允许跨月匹配。
- 总部集中采购是否需要跨门店分摊。
- 封账是否允许带未处理项强制通过。
- 单密码阶段如何记录实际操作人。

## 11. 我的建议

直接定：

- 后端：FastAPI。
- 后台：Next.js + Ant Design。
- 小程序：Taro + React + TypeScript。
- 数据库：PostgreSQL。
- 任务：Celery + Redis。
- 仓库：monorepo。

原因很明确：

- Python 后端最大化复用旧系统资产。
- React/TypeScript 覆盖后台和小程序，减少前端技术分裂。
- PostgreSQL 支撑财务数据长期演进。
- Celery/Redis 解决同步、导入、导出这些长任务。

下一步可以开始初始化项目骨架：

1. 建 monorepo 目录。
2. 初始化 FastAPI 服务。
3. 初始化 Next.js 后台。
4. 初始化 Taro 小程序。
5. 先落数据库 schema 和核心枚举。
6. 优先开发“门店账套 + 支出明细行 + 匹配关系”。

## 12. 参考资料

- Next.js App Router 官方文档：https://nextjs.org/docs/app
- FastAPI 官方文档：https://fastapi.tiangolo.com/
- Taro 文档：https://docs.taro.zone/
- 微信小程序官方文档：https://developers.weixin.qq.com/miniprogram/dev/framework/
