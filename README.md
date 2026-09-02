# fin-hub

蘑说财务管理系统新版工程，包含后台管理端、API 服务和股东小程序。

## 项目结构

```text
apps/
  admin-web/              # 后台管理端，Next.js + React + Ant Design
  api/                    # API 服务，FastAPI + SQLAlchemy + Alembic
  shareholder-miniapp/    # 股东小程序，Taro + React
packages/
  shared-types/           # 三端共享类型和枚举
  shared-api-client/      # 后台共享 API 客户端
  shared-utils/           # 共享格式化工具
docs/                     # PRD、旧系统分析、架构、交互、实现说明
infra/                    # Docker Compose、Nginx 配置
scripts/                  # 本地启动和后续运维脚本
```

## 本地启动

安装前端依赖：

```bash
pnpm install
```

一键启动本地开发服务：

```bash
scripts/dev.sh
```

也可以使用：

```bash
pnpm dev
```

只启动 API：

```bash
scripts/dev-api-postgres.sh
```

启动股东小程序：

```bash
pnpm dev:miniapp
```

微信开发者工具可从仓库根目录导入项目，根目录 `project.config.json` 会指向 `apps/shareholder-miniapp/dist/`。正式调试前需要把其中的 `appid` 从 `touristappid` 替换为真实小程序 AppID。

默认地址：

- 后台：`http://localhost:3000`
- API：`http://localhost:8000`
- OpenAPI：`http://localhost:8000/openapi.json`

默认开发账号：

- 后台管理员：`admin / admin123456`
- 股东授权码：`share123456`

## Docker Compose

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

Compose 会启动 PostgreSQL、Redis、API 和后台管理端。API 容器启动时执行数据库迁移，并在 `SEED_DEV_DATA=true` 时写入开发样例数据。

生产 Compose 使用：

```bash
cp .env.production.example .env.production
scripts/deploy-prod.sh
```

API 启动时只允许 PostgreSQL。生产环境还会拒绝弱 `SECRET_KEY`、空 `CORS_ORIGINS` 或包含 localhost 的跨域配置。

## 验证命令

API 测试：

```bash
apps/api/.venv/bin/pytest apps/api/tests
```

前端共享包：

```bash
pnpm --filter @fin-hub/shared-api-client typecheck
```

后台：

```bash
pnpm --filter @fin-hub/admin-web typecheck
pnpm --filter @fin-hub/admin-web build
```

股东小程序：

```bash
pnpm --filter @fin-hub/shareholder-miniapp typecheck
pnpm --filter @fin-hub/shareholder-miniapp build
```

上线前本地验收：

```bash
scripts/preflight.sh
```

注意：运行 `next build` 后，如果继续用 `pnpm dev:admin`，建议先移动 `apps/admin-web/.next`，避免开发服务读到生产构建产物导致 `_next/static` 404。

## 当前后台页面

- `/login`：后台登录
- `/`：首页仪表盘
- `/store-ledgers`：门店套帐入口，按当前维护人员可管理门店展示卡片
- `/store-ledgers/[storeId]`：单门店套帐工作台，聚合银行流水、审批单、对账、营业收入
- `/store-ledgers/[storeId]/approvals`：单门店审批单列表
- `/stores`：门店资料管理
- `/ledgers`：门店账套、封账检查、封账、反封账
- `/categories`：费用分类
- `/suppliers`：供应商档案
- `/revenue-channels`：收入渠道
- `/revenue`：营业收入新增、编辑、筛选，支持从门店套帐带入门店和账期
- `/expenses`：支出明细新增、编辑、凭证上传、钉钉凭证归档和下载
- `/bank`：银行流水新增、编辑、CSV/XLSX 预览和导入，支持从门店套帐带入门店和账期
- `/finance/reconciliation`：对账管理，支持门店上下文
- `/matching`：旧版匹配工作台、支出匹配、收入匹配、自动生成候选、确认、拒绝
- `/dingtalk`：钉钉配置、连接测试、审批模板、字段映射、审批同步
- `/reports`：财务报表、账套 CSV 导出
- `/shareholder-grants`：股东授权管理
- `/audit`：操作日志
- `/users`：后台用户管理
- `/settings`：系统设置、集成状态、PostgreSQL 备份策略提示

## 当前小程序页面

- `pages/shareholder-login/index`：股东授权码登录
- `pages/stores/index`：授权门店经营概览、整体趋势、门店排行、账期切换、搜索、排序、刷新、退出
- `pages/report/index`：门店账套报表详情、经营提醒、利润率、支出占比、趋势、分类/供应商支出排行、待处理支出、未匹配流水
- `pages/report/index` 同时展示营业收入明细

## 关键 API 模块

- `/api/auth`：后台登录、当前用户、退出
- `/api/users`：后台用户管理
- `/api/stores`：门店管理
- `/api/store-ledgers/{store_id}/workspace`：单门店套帐工作台聚合数据
- `/api/ledgers`：账套管理、封账检查、封账、反封账
- `/api/categories`：费用分类
- `/api/suppliers`：供应商档案
- `/api/revenue-channels`：收入渠道
- `/api/revenue-records`：营业收入记录
- `/api/expense-items`：支出明细
- `/api/attachments`：附件与凭证上传、查询、下载
- `/api/bank-transactions`：银行流水、导入预览、导入
- `/api/matches`：支出匹配、收入匹配、自动生成候选、确认、拒绝
- `/api/dingtalk`：钉钉配置、模板、映射、审批同步
- `/api/reports`：汇总报表、账套详情、CSV / Excel 导出
- `/api/shareholder-auth`：股东授权码登录、当前授权信息
- `/api/shareholder-grants`：股东授权管理
- `/api/audit-logs`：操作日志
- `/api/system`：数据库备份状态和下载

## 环境变量

参考 `.env.example`：

- `DATABASE_URL`
- `REDIS_URL`
- `APP_ENV`
- `SECRET_KEY`
- `CORS_ORIGINS`
- `FILE_STORAGE_ROOT`
- `DINGTALK_APP_KEY`
- `DINGTALK_APP_SECRET`
- `DINGTALK_DRIVE_UNION_ID`
- `DINGTALK_SYNC_MODE`
- `NEXT_PUBLIC_API_BASE_URL`
- `TARO_APP_API_BASE_URL`

生产环境不要使用默认 `SECRET_KEY`，钉钉 App Secret、数据库密码等密钥应放在服务端环境变量或密钥管理系统中。

## 参考文档

- [技术选型与三项目规划](docs/technical-stack-decision.md)
- [架构与交互规划](docs/fin-hub-architecture-interaction-plan.md)
- [PRD 分析总结](docs/moshuo-prd-analysis.md)
- [旧系统 API 汇总](docs/moshuo-api-usage-summary.md)
- [旧系统交互汇总](docs/moshuo-interaction-summary.md)
- [API 第一阶段实现说明](docs/api-first-implementation-notes.md)
- [后台管理第一阶段实现说明](docs/admin-first-implementation-notes.md)
- [小程序第一阶段实现说明](docs/miniapp-first-implementation-notes.md)
- [系统设置与数据库备份实现说明](docs/system-settings-and-backup-implementation-notes.md)
- [交付验收与发布检查](docs/preflight-and-release-checklist.md)
