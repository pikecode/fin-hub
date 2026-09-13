# fin-hub 文档目录

这里保留当前维护需要的文档入口。阶段总结、历史分析、已完成优化报告和一次性修复记录已归到 `archive/`，避免和仍在使用的说明重复。

## 必读入口

- [生产部署指南](operations/production-deployment.md)
- [交付验收与发布检查](operations/preflight-and-release-checklist.md)
- [脚本说明](runbooks/scripts.md)
- [API 服务说明](runbooks/api-service.md)
- [技术选型与三项目规划](architecture/technical-stack-decision.md)
- [架构与交互规划](architecture/fin-hub-architecture-interaction-plan.md)

## 主题文档

### 产品与旧系统

- [PRD 分析总结](product/moshuo-prd-analysis.md)
- [旧系统 API 汇总](product/moshuo-api-usage-summary.md)
- [旧系统交互汇总](product/moshuo-interaction-summary.md)

### 架构

- [技术选型与三项目规划](architecture/technical-stack-decision.md)
- [架构与交互规划](architecture/fin-hub-architecture-interaction-plan.md)

### 功能与实现

- [API 第一阶段实现说明](features/api-first-implementation-notes.md)
- [后台管理第一阶段实现说明](features/admin-first-implementation-notes.md)
- [小程序第一阶段实现说明](features/miniapp-first-implementation-notes.md)
- [登录认证第一阶段实现说明](features/auth-first-implementation-notes.md)
- [用户、角色与权限管理实现说明](features/user-permission-implementation-notes.md)
- [主数据模块实现说明](features/master-data-implementation-notes.md)
- [门店套帐工作台设计说明](features/store-ledger-workspace-design.md)
- [门店套帐端到端验收清单](features/store-ledger-e2e-acceptance-checklist.md)
- [门店总览报表化设计](features/store-ledger-overview-report-design.md)
- [银行流水导入与维护实现说明](features/bank-import-implementation-notes.md)
- [银行流水门店与账期归属设计](features/bank-transaction-store-period-design.md)
- [附件与凭证查看实现说明](features/attachments-implementation-notes.md)
- [报表与审计实现说明](features/reports-and-audit-implementation-notes.md)
- [系统设置与数据库备份实现说明](features/system-settings-and-backup-implementation-notes.md)

### 对账与收入

- [审批单明细与对账设计开发文档](features/approval-expense-line-design.md)
- [审批单明细与报销凭证对齐方案](features/approval-line-voucher-reconciliation-plan.md)
- [审批单对账明细分类优化方案](features/approval-reconciliation-detail-classification-plan.md)
- [审批单状态收敛方案](features/dingtalk-approval-match-status-cleanup-plan.md)
- [Approval Expense Reconciliation Optimization Plan](features/approval-expense-reconciliation-optimization-plan.md)
- [Approval Level Reconciliation Design](features/approval-level-reconciliation-design.md)
- [Revenue Channel Store Scope Design](features/revenue-channel-store-scope-design.md)
- [Revenue Channel Store Scope Implementation Plan](features/revenue-channel-store-scope-implementation-plan.md)
- [营业收入手续费月度支出设计](features/revenue-fee-monthly-expense-design.md)

### 钉钉集成

- [钉钉审批同步改造方案](integrations/dingtalk/approval-sync-strategy.md)
- [钉钉分阶段同步设计](integrations/dingtalk/staged-sync-design.md)
- [钉钉审批实例同步第一阶段实现说明](integrations/dingtalk/approval-sync-implementation-notes.md)
- [钉钉模板与字段映射第一阶段实现说明](integrations/dingtalk/template-mapping-implementation-notes.md)
- [钉钉审批同步漏数修复说明](integrations/dingtalk/approval-sync-window-fix.md)
- [钉钉审批漏数诊断与修复方案](integrations/dingtalk/approval-missing-diagnosis-and-repair.md)
- [钉钉审批全历史同步调整](integrations/dingtalk/approval-full-history-sync.md)
- [本地钉钉真实同步模式修改总结](integrations/dingtalk/local-real-mode-change-summary.md)

### 运维与手册

- [生产部署指南](operations/production-deployment.md)
- [预构建镜像部署方案](operations/prebuilt-image-deployment.md)
- [交付验收与发布检查](operations/preflight-and-release-checklist.md)
- [服务器 SSH 登录记录](operations/server-ssh-access.md)
- [本地连接生产数据库](operations/local-production-database.md)
- [脚本说明](runbooks/scripts.md)
- [API 服务说明](runbooks/api-service.md)
- [审批单重建运行手册](runbooks/approval-rebuild-runbook.md)
- [同步测试数据清理脚本](runbooks/sync-data-reset-script.md)

### UI

- [设计系统](ui/design-system.md)
- [组件使用指南](ui/component-guide.md)

## 归档规则

`archive/` 中保留历史上下文，但不再作为日常维护入口：

- `archive/analysis/`：项目分析、交付进度类历史文档。
- `archive/deployment/`：旧部署指南、演示记录和专项部署步骤。
- `archive/dingtalk/`：已完成或被新方案覆盖的钉钉问题分析、修复报告、同步优化总结。
- `archive/implementation/`：一次性实现或修复记录。
- `archive/optimization/`：P0/P1 优化计划、完成报告、清单和阶段总结。
- `archive/ui/`：UI/UX 历史评估、阶段报告和旧优化方案。
