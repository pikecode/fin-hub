# API报表性能优化发布记录

2026-11-14 Asia/Shanghai。用户授权仅部署API；源代码6981fd4，六个API文件来自4d582ac。

## 范围和版本

旧镜像 `fin-hub-api:deploy-20261113-approval`；新镜像 `fin-hub-api:deploy-20261114-report-performance`。仅上传report_reads.py、accrual_accounting.py、matching/accounting.py、store_ledgers/router.py、dividend/opening.py、miniapp/router.py，以旧镜像轻量封装。线上源码对比确认没有其他遗漏或删除；无依赖变更和数据库迁移，alembic仍20261113_0049。

10:29首轮切换；发现原始报表摘要不同后10:31恢复旧API；核对完成后10:37再次发布。仅API容器重建，其他容器ID和启动时间不变，Nginx检查后reload刷新代理。

## 首轮摘要差异说明

万民汇报表中的两个分类金额相同，原汇总仅按金额排序，进程哈希种子不同会改变两行顺序。差异路径仅expense_category_summary中的名称及随行笔数交换；金额、分类项目和数量未改变。旧版PYTHONHASHSEED=3也能复现，排除本次性能改动引入金额差异。

临时恢复后在生产REPEATABLE READ/READ ONLY事务内对比旧新逻辑，两店完整报表/分红一致，146个账期支出差异0。随后将HTTP核验摘要中的分类列表按名称对齐并去除retrieved_at，其他字段原样对比。恢复与再发布均记录于CHANGELOG，未恢复数据库或改动账目。本次没有额外修改分类排序行为。

## 验收

19项相关回归通过；新镜像可导入，运行六文件SHA256与manifest一致。最终API正常、重启0、启动完成且未发现Traceback。/api/health正常、/login及20个JS/CSS资源200。用现有合法账户签发临时内存令牌只读验证/me、/stores和两店报表/分红，内网及公网六份响应200，规范化摘要与发布前一致；无登录密码输出或重置，无测试业务写入。

首次实际HTTP采样（秒）：

| 门店 | 报表前→后 | 分红前→后 |
| --- | --- | --- |
| 万民汇 | 1.1812→0.5990 | 1.3694→0.3967 |
| 华丰汇 | 1.4320→0.5635 | 1.7223→0.4992 |

最终复发后内网报表0.5855/0.6714秒、分红0.4016/0.4998秒。为有限次服务器HTTP采样，不代表手机端到端耗时或所有门店保证。小程序客户端仍须另上传以获得新UI、会话恢复及并发合并。

## 证据、备份与回退

服务器release `/opt/fin-hub/releases/deploy-20261114-report-performance/`，env.before权限600，manifest包含完整文件摘要，保留旧镜像。比较脚本只读、令牌仅内存使用，证据输出不包含令牌。本地资料 `/tmp/finhub-api-deploy-20261114/`，生产核验副本置于release/evidence。

工作分支 `work/20261114-api-performance-deploy-01`，前备份 `backup/20261114-api-performance-deploy-01-before`（6981fd4）；文档提交完成后创建after备份，两者未推送远程。

生产回退：只将API_IMAGE恢复为旧镜像，按增量部署文档up -d --no-deps api，验证API启动、nginx -t/reload、公网健康及鉴权接口。禁止整份env回写覆盖其他期间配置，禁止默认降级或恢复数据库。代码文档回退通过revert对应提交。
